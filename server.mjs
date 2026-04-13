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
import { randomUUID } from 'node:crypto';
import { MCP_URL } from './config.mjs';
import { loadTokens, refresh, interactiveLogin } from './oauth.mjs';

function log(...args) {
  console.error('[sf-bridge/server]', ...args);
}

let tokens = loadTokens();
if (!tokens) {
  // First run (typical for a fresh DXT install): run the OAuth flow inline.
  // This opens the user's browser; once they authorize, tokens are saved and
  // we proceed normally. If the user doesn't complete within 5 min, we exit.
  log('No tokens on disk — launching first-time OAuth flow.');
  log('A browser window will open to authenticate against your Salesforce org.');
  try {
    tokens = await interactiveLogin();
    log('OAuth complete. Tokens saved.');
  } catch (e) {
    log('❌ OAuth failed:', e.message);
    process.exit(2);
  }
}

// Salesforce's MCP endpoint uses the Streamable HTTP transport: a session is
// established on initialize (Mcp-Session-Id header in response), subsequent
// calls must carry that header.
let sessionId = null;

async function forward(message, { allowRefresh = true } = {}) {
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
  if (!text) return null; // notifications have no response body
  try { return JSON.parse(text); }
  catch { throw new Error(`Non-JSON response (HTTP ${resp.status}): ${text.slice(0, 300)}`); }
}

function writeOut(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try { msg = JSON.parse(raw); }
  catch (e) { log('Invalid JSON from client:', raw.slice(0, 200)); return; }

  // Notifications have no id — forward and do not write a response.
  const isNotification = msg.id === undefined || msg.id === null;
  log('→', msg.method, msg.id !== undefined ? `id=${msg.id}` : '(notification)');

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
