// OAuth 2.0 Authorization Code + PKCE flow against the org's My Domain.
// Handles initial login (interactive, opens browser) and silent refresh.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import {
  AUTHORIZE_URL,
  TOKEN_URL,
  CLIENT_ID,
  getClientSecret,
  CALLBACK_PORT,
  CALLBACK_URL,
  SCOPES,
  RESOURCE,
  TOKENS_FILE,
  STATE_DIR,
} from './config.mjs';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function log(...args) {
  // stderr — stdout is reserved for MCP JSON-RPC.
  console.error('[sf-bridge/oauth]', ...args);
}

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

export function loadTokens() {
  if (!existsSync(TOKENS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  ensureStateDir();
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  chmodSync(TOKENS_FILE, 0o600);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    log('Could not auto-open browser:', e.message);
  }
}

// Interactive login: opens browser, spins up a localhost callback, exchanges
// the code for tokens. Blocks until complete. Returns the tokens object.
export async function interactiveLogin() {
  const { verifier, challenge } = makePkce();
  const state = b64url(randomBytes(16));

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', CALLBACK_URL);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('resource', RESOURCE);

  // Spin up callback server.
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (u.pathname !== '/oauth/callback') {
        res.writeHead(404); res.end('not found'); return;
      }
      const gotState = u.searchParams.get('state');
      const gotCode = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>OAuth error</h1><pre>${err}: ${u.searchParams.get('error_description') || ''}</pre>`);
        server.close();
        reject(new Error(`OAuth error: ${err}`));
        return;
      }
      if (gotState !== state) {
        res.writeHead(400); res.end('state mismatch');
        server.close();
        reject(new Error('state mismatch'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>✅ Salesforce connected</h1><p>You can close this tab.</p>');
      server.close();
      resolve(gotCode);
    });
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      log(`Callback server listening on ${CALLBACK_URL}`);
      log('Opening browser for Salesforce login…');
      log('If it does not open, visit this URL manually:');
      log(authUrl.toString());
      openBrowser(authUrl.toString());
    });
    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('OAuth timeout (5 min)')); }, 5 * 60 * 1000);
  });

  // Exchange code for tokens.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    client_secret: getClientSecret(),
    redirect_uri: CALLBACK_URL,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
  const tokens = {
    access_token: data.access_token,
    id_token: data.id_token,
    refresh_token: data.refresh_token,
    instance_url: data.instance_url,
    issued_at: Number(data.issued_at) || Date.now(),
    scope: data.scope,
    token_type: data.token_type || 'Bearer',
  };
  saveTokens(tokens);
  log('Tokens saved to', TOKENS_FILE);
  return tokens;
}

// Refresh: uses the refresh_token to get a new access_token.
export async function refresh(tokens) {
  if (!tokens?.refresh_token) throw new Error('No refresh_token available');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: CLIENT_ID,
    client_secret: getClientSecret(),
    resource: RESOURCE,
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Refresh failed: ${JSON.stringify(data)}`);
  const next = {
    ...tokens,
    access_token: data.access_token,
    issued_at: Number(data.issued_at) || Date.now(),
  };
  if (data.refresh_token) next.refresh_token = data.refresh_token;
  saveTokens(next);
  return next;
}

// Returns a valid access token, refreshing if needed. If no tokens exist,
// throws — caller should run `npm run auth` first.
export async function getAccessToken() {
  let tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated. Run: npm run auth');
  // Salesforce access tokens are typically valid ~2h. We refresh opportunistically
  // on 401 in the server; this function just returns what we have.
  return tokens;
}
