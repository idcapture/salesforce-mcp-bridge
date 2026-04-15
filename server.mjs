#!/usr/bin/env node
// Stdio MCP bridge: pipes JSON-RPC 2.0 messages between the MCP client
// (Claude Desktop / Claude Code) and the Salesforce hosted MCP HTTP endpoint,
// injecting a Bearer token from the local OAuth state.
//
// Why this exists: Salesforce's hosted MCP advertises broken OAuth discovery
// metadata on api.salesforce.com (the authorization_servers URL doesn't serve
// metadata at any standard path). mcp-remote and Claude Connectors both
// choke on this. We side-step the whole discovery problem by doing the
// OAuth flow ourselves against the org's My Domain, then forwarding
// MCP traffic to the hosted endpoint with a regular Bearer header.

import { createInterface } from 'node:readline';
import { MCP_URL } from './config.mjs';
import { loadTokens, refresh, interactiveLogin } from './oauth.mjs';

function log(...args) {
  console.error('[sf-bridge/server]', ...args);
}

// --- Auth state ---
// tokens is either loaded from disk or set by the OAuth background flow.
// authReady resolves when tokens are available; rejects if OAuth failed.
let tokens = loadTokens();
const authReady = tokens
  ? Promise.resolve(tokens)
  : (() => {
      log('No tokens on disk — starting OAuth flow in background.');
      log('A browser window will open; complete the Salesforce consent to continue.');
      return interactiveLogin()
        .then(t => {
          tokens = t;
          log('OAuth complete. Tokens saved.');
          // Tell the MCP client that the real server's tool list is now
          // available so it re-queries us (forwarding to the remote).
          writeOut({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
          return t;
        })
        .catch(e => {
          log('❌ OAuth failed:', e.message);
          throw e;
        });
    })();
// Prevent node from crashing on unhandled rejection if the client never
// sends a message after an auth failure.
authReady.catch(() => {});

// Salesforce's MCP endpoint uses the Streamable HTTP transport: a session is
// established on initialize (Mcp-Session-Id header in response), subsequent
// calls must carry that header.
let sessionId = null;
let remoteInitPromise = null;

// Ensure the bridge has completed the MCP handshake (initialize +
// notifications/initialized) with the remote Salesforce endpoint. Required
// when we synthesized the client's initialize ourselves (no-tokens case):
// the remote has not yet seen a real initialize, so sessionId is unset and
// any subsequent call is rejected with "Session Key missing, but it's not
// an initialize request". Idempotent — subsequent calls are no-ops.
async function ensureRemoteInitialized() {
  if (sessionId) return;
  if (!remoteInitPromise) {
    remoteInitPromise = (async () => {
      log('Performing MCP handshake with remote Salesforce endpoint…');
      const initMsg = {
        jsonrpc: '2.0',
        id: 'bridge-init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'salesforce-mcp-bridge', version: '0.1.4' },
        },
      };
      await forward(initMsg, { skipInit: true });
      // Some MCP servers also require the notifications/initialized ack
      // before accepting tool calls. Send it fire-and-forget.
      try {
        await forward(
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { skipInit: true }
        );
      } catch (e) {
        log('notifications/initialized post-handshake failed (non-fatal):', e.message);
      }
      log('Remote MCP session established:', sessionId || '(no session id returned)');
    })();
  }
  return remoteInitPromise;
}

async function forward(message, { allowRefresh = true, skipInit = false } = {}) {
  if (!skipInit) await ensureRemoteInitialized();
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${tokens.access_token}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });

  // Capture session id on first successful response.
  const newSession = resp.headers.get('mcp-session-id');
  if (newSession && !sessionId) sessionId = newSession;

  if (resp.status === 401 && allowRefresh && tokens.refresh_token) {
    log('Access token rejected (401) — refreshing and retrying once');
    tokens = await refresh(tokens);
    return forward(message, { allowRefresh: false });
  }

  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    // Streamable HTTP can return SSE — collect the first `data:` line as the response.
    const text = await resp.text();
    const match = text.match(/^data:\s*(.+)$/m);
    if (match) return JSON.parse(match[1]);
    throw new Error(`SSE response with no data line: ${text.slice(0, 200)}`);
  }

  const text = await resp.text();

  // Non-2xx from the remote MCP endpoint returns an HTTP-level error body
  // (not a JSON-RPC response). Surface it as a thrown error so the caller
  // can produce a proper JSON-RPC error for the client.
  if (!resp.ok) {
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      if (j?.error) {
        const code = j.error.code ?? resp.status;
        const msg = j.error.message ?? text.slice(0, 200);
        detail = `[${code}] ${msg}`;
      }
    } catch { /* not JSON, use raw text */ }
    throw new Error(`Remote MCP HTTP ${resp.status}: ${detail}`);
  }

  if (!text) return null; // notifications have no response body
  try { return JSON.parse(text); }
  catch { throw new Error(`Non-JSON response (HTTP ${resp.status}): ${text.slice(0, 300)}`); }
}

function writeOut(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Synthesize an initialize response when we can't forward (no tokens yet).
// We advertise minimal tool capability; the real tool list comes from the
// remote once auth completes (signalled via tools/list_changed above).
function synthesizeInitializeResponse(msg) {
  return {
    jsonrpc: '2.0',
    id: msg.id,
    result: {
      protocolVersion: msg.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'salesforce-mcp-bridge', version: '0.1.4' },
    },
  };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try { msg = JSON.parse(raw); }
  catch (e) { log('Invalid JSON from client:', raw.slice(0, 200)); return; }

  const isNotification = msg.id === undefined || msg.id === null;
  log('→', msg.method, msg.id !== undefined ? `id=${msg.id}` : '(notification)');

  // initialize always responds immediately so the MCP client does not kill
  // us while OAuth runs. If tokens are already present, we forward for a
  // truthful response; otherwise synthesize from the bridge's identity.
  if (msg.method === 'initialize') {
    if (tokens) {
      try {
        // The client's initialize IS the remote handshake; skip the
        // ensureRemoteInitialized guard to avoid sending a second one.
        // forward() will still capture sessionId from the response header.
        const response = await forward(msg, { skipInit: true });
        if (response) writeOut(response);
        return;
      } catch (e) {
        log('initialize forward failed, falling back to synthetic:', e.message);
      }
    }
    writeOut(synthesizeInitializeResponse(msg));
    return;
  }

  // Everything else waits for auth. If auth fails, return a clear error.
  try {
    await authReady;
  } catch (e) {
    if (!isNotification) {
      writeOut({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: `Salesforce authentication failed: ${e.message}` },
      });
    }
    return;
  }

  try {
    const response = await forward(msg);
    log('←', msg.method, response ? (response.error ? `error ${response.error.code}` : 'ok') : '(empty)');
    if (!isNotification && response) writeOut(response);
  } catch (e) {
    log('Forward error:', e.message);
    if (!isNotification) {
      writeOut({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: String(e.message || e) },
      });
    }
  }
});

rl.on('close', () => {
  log('stdin closed, exiting');
  process.exit(0);
});

log('Ready. MCP_URL =', MCP_URL);
