# salesforce-mcp-bridge

[![Latest release](https://img.shields.io/github/v/release/idcapture/salesforce-mcp-bridge?label=Download%20.dxt&logo=github&color=2ea44f)](https://github.com/idcapture/salesforce-mcp-bridge/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Made for Claude Desktop](https://img.shields.io/badge/Claude%20Desktop-extension-D97706)](https://claude.ai/download)
[![GitHub stars](https://img.shields.io/github/stars/idcapture/salesforce-mcp-bridge?style=social)](https://github.com/idcapture/salesforce-mcp-bridge)

> **Talk to your Salesforce org from Claude.** A drop-in Claude Desktop extension (`.dxt`) that connects Claude to Salesforce's Hosted MCP servers in one click — and side-steps the broken OAuth discovery on `api.salesforce.com` that blocks `mcp-remote` and Claude Connectors as of mid-2026.

---

## Why this exists

Salesforce ships **Hosted MCP Servers** — `sobject-reads`, `sobject-all`, etc. — that let any MCP client query SOQL, traverse relationships, and read schema in plain English. Brilliant idea, but the gateway at `api.salesforce.com` has two interop gaps that block standards-compliant clients:

1. **Broken OAuth discovery** — `/.well-known/oauth-protected-resource` advertises an authorization server with no resolvable metadata. `mcp-remote` and Claude Connectors hang or error out.
2. **JWT-only tokens** — the gateway rejects classic SID tokens (`"JWT Token is required"`) unless the External Client App explicitly opts in to JWT format.

This bridge does the OAuth flow **directly against your org's My Domain** (which works fine), forwards MCP traffic to `api.salesforce.com` with a JWT Bearer token, and ships as a one-click `.dxt` extension for Claude Desktop. Once Salesforce fixes their discovery metadata, this becomes obsolete — until then, this is the path that works.

```
Claude Desktop  ──stdio JSON-RPC──▶  bridge (this)  ──HTTPS+Bearer──▶  api.salesforce.com
```

## Install (Claude Desktop, recommended)

[![Download latest .dxt](https://img.shields.io/github/v/release/idcapture/salesforce-mcp-bridge?label=Download%20latest%20.dxt&logo=github&style=for-the-badge&color=2ea44f)](https://github.com/idcapture/salesforce-mcp-bridge/releases/latest)

1. Download the `.dxt` file from the latest [release](https://github.com/idcapture/salesforce-mcp-bridge/releases/latest)
2. Double-click it. Claude Desktop opens an install dialog.
3. Fill in:
   - **Salesforce My Domain** — e.g. `acme.my.salesforce.com`
   - **OAuth Consumer Key** — from your Salesforce External Client App
   - **OAuth Consumer Secret** — leave **empty** (PKCE-only public client; works out of the box)
4. Click **Install**.
5. On your first Salesforce question to Claude, your browser opens once for the OAuth login. Done.

> **Requirements:** Claude Desktop ≥ 0.10, Node.js ≥ 20 on the host machine.

## Salesforce side — one-time setup

In your Salesforce org:

### 1. Enable the Hosted MCP Server

Setup → **MCP Servers** → enable `platform.sobject-reads` (read-only, recommended) or `platform.sobject-all` (full CRUD).

### 2. Create an External Client App

Setup → **External Client App Manager** → New External Client App.

**OAuth Settings**

- **Callback URL**: `http://localhost:8765/oauth/callback`
- **Selected Scopes**:
  - `Access Salesforce-hosted MCP servers (mcp_api)`
  - `Perform requests at any time (refresh_token, offline_access)`

**Security**

- ✅ **Issue JSON Web Token (JWT)-based access tokens for named users** *(critical — without this the gateway rejects every token)*
- ✅ **Require Proof Key for Code Exchange (PKCE) for supported authorization flows**

**Policies**

- `Permitted Users`: `All users may self-authorize` (or restrict via Permission Set as needed)

### 3. Grab the Consumer Key

ECA → Settings → **Consumer Key and Secret** → copy the Consumer Key.

You're done — paste it into the Claude Desktop install dialog above. No need to copy the secret if your ECA leaves "Require secret for Web Server Flow" checked, since PKCE-only public client mode works regardless.

## What you get — 6 tools

After install, ask Claude things like:

| Question to Claude | Tool used |
|---|---|
| *"Who am I in Salesforce?"* | `getUserInfo` |
| *"How many Tech-sector accounts do I have?"* | `soqlQuery` |
| *"Find anything matching 'Acme' across all objects."* | `find` (SOSL) |
| *"My 5 most recently viewed Cases"* | `listRecentSobjectRecords` |
| *"All contacts for the Acme account"* | `getRelatedRecords` |
| *"Show me the schema of Opportunity, custom fields only"* | `getObjectSchema` |

## Use without Claude Desktop (Claude Code, Cursor, raw)

```bash
git clone https://github.com/idcapture/salesforce-mcp-bridge.git
cd salesforce-mcp-bridge

# Configure (env vars, or ~/.salesforce-mcp-bridge/config.json)
export SF_ORG_DOMAIN='acme.my.salesforce.com'
export SF_CLIENT_ID='3MVG9…'
# SF_CLIENT_SECRET is optional — leave unset for PKCE-only

# One-off OAuth login (opens browser)
npm run auth

# Wire into Claude Code
claude mcp add salesforce --scope user -- node $(pwd)/server.mjs
```

For Cursor, Windsurf, Zed: point your MCP client at `node /absolute/path/to/server.mjs`.

## Configuration reference

| Env var              | Config key       | Default                    | Required |
|----------------------|------------------|----------------------------|----------|
| `SF_ORG_DOMAIN`      | `orgDomain`      | —                          | ✅       |
| `SF_CLIENT_ID`       | `clientId`       | —                          | ✅       |
| `SF_CLIENT_SECRET`   | `clientSecret`   | —                          | (PKCE-only if absent) |
| `SF_MCP_SERVER`      | `server`         | `platform/sobject-reads`   |          |
| `SF_CALLBACK_PORT`   | `callbackPort`   | `8765`                     |          |
| `SF_SCOPES`          | `scopes`         | `mcp_api refresh_token`    |          |
| `SF_STATE_DIR`       | —                | `~/.salesforce-mcp-bridge` |          |

Lookup order: env var → `~/.salesforce-mcp-bridge/config.json` → default.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Not authenticated` on first MCP call | Re-trigger OAuth: in Claude Desktop, Disable then Enable the extension |
| OAuth `OAUTH_APPROVAL_ERROR_GENERIC` | The ECA is missing `mcp_api` scope or the user isn't authorized in Policies |
| Auth OK but `Invalid token` on tool calls | Enable **Issue JWT-based access tokens for named users** in the ECA's Security section, then re-auth |
| `"empty serverURI"` | The bridge picks the right URL automatically — make sure your `SF_MCP_SERVER` is in the `platform/<server-name>` form |
| Port 8765 in use | Set `SF_CALLBACK_PORT` to a free port and add a matching Callback URL to the ECA |

For the verbose path: `~/.salesforce-mcp-bridge/tokens.json` (per-user, chmod 600), bridge logs are visible in Claude Desktop → Settings → Developer.

## Build the .dxt yourself

```bash
./dxt/build.sh
# → dxt/dist/salesforce-mcp-bridge-X.Y.Z.dxt
```

## Security model

- The Consumer Key is a **public OAuth client identifier** — by design exposed in client packages, no risk in distributing it.
- The Consumer Secret is **never embedded in the .dxt** — provided per-user (or omitted entirely with PKCE).
- Tokens (access + refresh) are stored locally in `~/.salesforce-mcp-bridge/tokens.json`, chmod 600, never sent anywhere except `api.salesforce.com`.
- The bridge opens a localhost callback port **only during the one-off OAuth flow**; no port stays open while serving MCP traffic.
- The default server (`sobject-reads`) is **read-only**. If you switch to `sobject-all`, restrict via Salesforce Profile/Permission Set.

## Limitations

- Single-user per `tokens.json`
- stdio transport only (no SSE/HTTP)
- MCP protocol pinned to `2024-11-05`

## Contributing

PRs welcome. Especially interested in:
- Streamable HTTP session lifecycle support
- Dynamic Client Registration fallback once Salesforce ships proper AS metadata
- Removing the bridge entirely once `mcp-remote` works against `api.salesforce.com` natively

If Salesforce fixes their `/.well-known/oauth-authorization-server` on `api.salesforce.com`, this whole project becomes a footnote — that's the goal.

## License

[MIT](LICENSE) © ID Capture
