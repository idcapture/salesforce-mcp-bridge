// Configuration — all values come from env vars or a local config file.
// See README.md for setup.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

export const STATE_DIR = process.env.SF_STATE_DIR || join(homedir(), '.salesforce-mcp-bridge');
export const TOKENS_FILE = join(STATE_DIR, 'tokens.json');
export const SECRET_FILE = join(STATE_DIR, 'secret');
export const CONFIG_FILE = join(STATE_DIR, 'config.json');

// Load optional JSON config (alternative to env vars for convenience).
function loadJsonConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
const fileConfig = loadJsonConfig();

function req(envName, fileName, description) {
  const v = process.env[envName] ?? fileConfig[fileName];
  if (!v) {
    throw new Error(
      `Missing ${description}. Set env var ${envName} or add "${fileName}" to ${CONFIG_FILE}.`
    );
  }
  return String(v);
}

function opt(envName, fileName, fallback) {
  return process.env[envName] ?? fileConfig[fileName] ?? fallback;
}

// --- Required ---
export const ORG_DOMAIN = req('SF_ORG_DOMAIN', 'orgDomain',
  'org My Domain (e.g., acme.my.salesforce.com)');
export const CLIENT_ID = req('SF_CLIENT_ID', 'clientId',
  'External Client App Consumer Key');

// --- Optional with defaults ---
export const SERVER_NAME = opt('SF_MCP_SERVER', 'server', 'platform/sobject-reads');
export const CALLBACK_PORT = Number(opt('SF_CALLBACK_PORT', 'callbackPort', 8765));
export const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/oauth/callback`;
export const SCOPES = opt('SF_SCOPES', 'scopes', 'api sfap_api refresh_token');

// Resource indicator (RFC 8707) — kept for future-proofing even though the
// Salesforce token endpoint currently ignores it.
export const RESOURCE = opt('SF_RESOURCE', 'resource', 'https://api.salesforce.com/');

// --- Derived URLs ---
export const AUTHORIZE_URL = `https://${ORG_DOMAIN}/services/oauth2/authorize`;
export const TOKEN_URL = `https://${ORG_DOMAIN}/services/oauth2/token`;
export const MCP_URL = `https://api.salesforce.com/platform/mcp/v1/${SERVER_NAME}`;

// --- Secret loader ---
// Returns the Consumer Secret if configured, or null if not. When null, the
// OAuth flow runs as a public client (PKCE-only) — this is Salesforce's
// recommended setup for MCP clients and requires "Require secret for Web
// Server Flow" AND "Require secret for Refresh Token Flow" to be DISABLED
// on the External Client App.
export function getClientSecret() {
  if (process.env.SF_CLIENT_SECRET) return process.env.SF_CLIENT_SECRET;
  if (fileConfig.clientSecret) return String(fileConfig.clientSecret);
  if (existsSync(SECRET_FILE)) {
    const s = readFileSync(SECRET_FILE, 'utf8').trim();
    return s || null;
  }
  return null;
}
