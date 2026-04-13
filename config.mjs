// Configuration — edit the values here, or override via env vars.
// Consumer Key is not secret (it's a public identifier). Consumer Secret IS
// loaded from env (SF_CLIENT_SECRET) or from ~/.idcapture-salesforce-bridge/secret.
// Do NOT commit the secret to this file.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

export const ORG_DOMAIN = process.env.SF_ORG_DOMAIN || 'idcapture.my.salesforce.com';
export const MY_DOMAIN_NAME = process.env.SF_MY_DOMAIN || 'idcapture';
export const SERVER_NAME = process.env.SF_MCP_SERVER || 'platform/sobject-reads';
export const CLIENT_ID = process.env.SF_CLIENT_ID
  || '3MVG9gYjOgxHsENKfY5XT4SEP2v.3QiKRNR3wEzrL7eDHGHX2kmPSf3LtJP7myB_cp.TQwC2ISbxMGseNasoa';

export const STATE_DIR = join(homedir(), '.idcapture-salesforce-bridge');
export const TOKENS_FILE = join(STATE_DIR, 'tokens.json');
export const SECRET_FILE = join(STATE_DIR, 'secret');

export function getClientSecret() {
  if (process.env.SF_CLIENT_SECRET) return process.env.SF_CLIENT_SECRET;
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf8').trim();
  throw new Error(
    `Consumer Secret not found. Set SF_CLIENT_SECRET env var OR write it to ${SECRET_FILE} (chmod 600).`
  );
}

export const CALLBACK_PORT = Number(process.env.SF_CALLBACK_PORT || 8765);
export const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/oauth/callback`;
export const SCOPES = 'mcp_api refresh_token';
// Resource indicator (RFC 8707): audience-scope the token to api.salesforce.com
// so the hosted MCP accepts it. Without this, /userinfo works but the MCP
// endpoints return "Invalid token".
export const RESOURCE = 'https://api.salesforce.com/';

// OAuth endpoints — directly on the org's My Domain (bypasses the broken
// discovery on api.salesforce.com).
export const AUTHORIZE_URL = `https://${ORG_DOMAIN}/services/oauth2/authorize`;
export const TOKEN_URL = `https://${ORG_DOMAIN}/services/oauth2/token`;

// MCP endpoint — use the non-My-Domain path for production orgs where
// login.salesforce.com is enabled. The `/d/{mydomain}/` variant documented
// in the Salesforce wiki returns "empty serverURI" for IDCapture (Salesforce
// routing quirk); the plain `/{servername}` path works once tokens are JWT.
export const MCP_URL = `https://api.salesforce.com/platform/mcp/v1/${SERVER_NAME}`;
