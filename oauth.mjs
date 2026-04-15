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

// HTML landing page shown to the user at http://localhost:CALLBACK_PORT/
// BEFORE they hit Salesforce. Gives them a chance to see the incognito
// warning — critical because Salesforce's "invalid_client_id" error for
// the wrong-org-session case is shown in the browser (not relayed via
// the OAuth callback), so stderr logs never reach the user.
function landingPageHtml(authUrlString) {
  // Escape for safe HTML attribute and text usage.
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const url = esc(authUrlString);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connect Salesforce</title>
<style>
  body { font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
         max-width: 680px; margin: 3rem auto; padding: 0 1.5rem; color: #1a202c; }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
  .btn { display: inline-block; padding: 0.75rem 1.5rem; margin: 1rem 0;
         background: #0176d3; color: white; text-decoration: none; border-radius: 6px;
         font-weight: 500; }
  .btn:hover { background: #014a85; }
  .warning { border-left: 4px solid #ffa500; background: #fff8ed; padding: 1rem 1.25rem;
             margin: 1.5rem 0; border-radius: 4px; }
  .warning strong { color: #b75c00; }
  details { margin-top: 1rem; }
  summary { cursor: pointer; color: #4a5568; }
  code { background: #f4f4f5; padding: 2px 5px; border-radius: 3px;
         font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.9em; }
  .urlbox { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .urlbox input { flex: 1; padding: 0.5rem; font-family: ui-monospace, Menlo, Consolas, monospace;
                  font-size: 0.8em; border: 1px solid #cbd5e0; border-radius: 4px; }
  .urlbox button { padding: 0 1rem; background: #edf2f7; border: 1px solid #cbd5e0;
                   border-radius: 4px; cursor: pointer; }
  .urlbox button:hover { background: #e2e8f0; }
</style>
</head>
<body>
<h1>Connect Claude to Salesforce</h1>
<p>One-time authorization against your Salesforce org.</p>

<a href="${url}" class="btn">Authorize Salesforce →</a>

<div class="warning">
  <p><strong>⚠ If the next page shows &ldquo;invalid_client_id&rdquo;</strong>, your browser
     is signed into a different Salesforce org, and its session cookie is confusing the authorize
     endpoint.</p>
  <p><strong>Fix:</strong> right-click the button above and choose
     <em>&ldquo;Open in InPrivate window&rdquo;</em> (Edge) or
     <em>&ldquo;Open in incognito&rdquo;</em> (Chrome) — or copy the URL below into a private
     window manually.</p>
</div>

<details>
  <summary>Show the authorization URL</summary>
  <div class="urlbox">
    <input id="u" readonly value="${url}">
    <button onclick="navigator.clipboard.writeText(document.getElementById('u').value);
                    this.textContent='Copied'; setTimeout(()=>this.textContent='Copy', 1500);">Copy</button>
  </div>
</details>

<p style="margin-top: 2rem; color: #718096; font-size: 0.9em;">
  This page is served by the Salesforce MCP bridge on <code>localhost:${CALLBACK_PORT}</code>.
  Close this tab after you finish authorizing.
</p>
</body>
</html>`;
}

// Cookieless probe of the authorize endpoint. Because Salesforce's /authorize
// uses the browser's existing session cookies to resolve the target org,
// a user who is logged into a DIFFERENT org in their default browser will
// see "invalid_client_id" even if the ECA is correctly configured on the
// target org. A Node-side fetch (no cookies) tells us whether the ECA itself
// is valid, so we can guide the user if the issue is client-side.
async function preflightProbe(authUrl) {
  try {
    const resp = await fetch(authUrl, { method: 'GET', redirect: 'manual' });
    if (resp.status === 302) return { ok: true };
    if (resp.status === 400) {
      const text = await resp.text();
      const m = /error=([^&]+)/.exec(text);
      const descMatch = /error_description=([^&]+)/.exec(text);
      return {
        ok: false,
        error: m ? decodeURIComponent(m[1]) : 'unknown',
        description: descMatch ? decodeURIComponent(descMatch[1].replace(/\+/g, ' ')) : '',
      };
    }
    return { ok: false, error: 'unexpected_status', description: `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: 'network', description: e.message };
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

      // Landing page — shown to the user BEFORE they hit Salesforce.
      // This is where we warn them about the invalid_client_id cookie trap.
      if (u.pathname === '/' || u.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(landingPageHtml(authUrl.toString()));
        return;
      }

      if (u.pathname !== '/oauth/callback') {
        res.writeHead(404); res.end('not found'); return;
      }
      const gotState = u.searchParams.get('state');
      const gotCode = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      if (err) {
        const desc = u.searchParams.get('error_description') || '';
        // Note: for client_id/redirect_uri validation errors, Salesforce does
        // NOT redirect here — it shows its own error page. Cases that DO
        // reach this callback: user denied consent, session revoked, etc.
        const hint = err === 'access_denied'
          ? '<p>You denied the authorization. Restart the bridge to try again.</p>'
          : '<p>Check the bridge stderr logs for more detail.</p>';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>OAuth error: ${err}</h1><pre>${desc}</pre>${hint}`);
        server.close();
        reject(new Error(`OAuth error: ${err} — ${desc}`));
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
    server.listen(CALLBACK_PORT, '127.0.0.1', async () => {
      log(`Callback server listening on ${CALLBACK_URL}`);

      // Preflight: does SF accept this client_id without browser cookies?
      const probe = await preflightProbe(authUrl.toString());
      if (!probe.ok && probe.error === 'invalid_client_id') {
        // ECA is genuinely not recognised by the org. Don't bother opening
        // the browser — the user would just see the same error.
        server.close();
        reject(new Error(
          `Salesforce rejected the client_id: ${probe.error} (${probe.description}). ` +
          `Check that your External Client App Consumer Key matches what's in ${ORG_DOMAIN}'s Setup, ` +
          `that the ECA's Distribution State is "Packaged", and that it allows self-authorization.`
        ));
        return;
      }
      if (!probe.ok) {
        log(`Preflight warning: ${probe.error} — ${probe.description}. Continuing anyway.`);
      }

      const landingUrl = `http://localhost:${CALLBACK_PORT}/`;
      log('Opening browser for Salesforce login…');
      log(`Landing page:     ${landingUrl}`);
      log(`Authorize URL:    ${authUrl.toString()}`);
      log('');
      log('⚠ If the Salesforce page shows "invalid_client_id", your browser is');
      log('  logged into a different Salesforce org. The landing page above has');
      log('  instructions for opening the URL in a Private/Incognito window.');
      openBrowser(landingUrl);
    });
    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('OAuth timeout (5 min)')); }, 5 * 60 * 1000);
  });

  // Exchange code for tokens. client_secret is omitted if not configured —
  // Salesforce accepts public client + PKCE when the ECA has "Require secret
  // for Web Server Flow" disabled.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  const secret = getClientSecret();
  if (secret) body.set('client_secret', secret);
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
    resource: RESOURCE,
  });
  const secret = getClientSecret();
  if (secret) body.set('client_secret', secret);
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
