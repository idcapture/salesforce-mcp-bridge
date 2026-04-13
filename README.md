# salesforce-mcp-bridge

Stdio MCP bridge to **Salesforce Hosted MCP Servers** (`sobject-reads`,
`sobject-all`, etc.) for Claude Desktop, Claude Code, and any other
stdio-based MCP client.

Works around the broken OAuth discovery metadata on `api.salesforce.com`
that prevents `mcp-remote` and Claude Connectors from authenticating
against a Salesforce Hosted MCP server as of 2026-Q2.

## What it does

```
Claude Desktop / Claude Code / Cursor / any stdio MCP client
     │  stdio JSON-RPC 2.0
     ▼
server.mjs  (this bridge, runs locally)
     │  HTTPS + Bearer <JWT>
     ▼
https://api.salesforce.com/platform/mcp/v1/<server>
```

OAuth is done directly against the org's My Domain
(`<org>.my.salesforce.com/services/oauth2/authorize`) — bypassing the broken
discovery on `api.salesforce.com`. Tokens are cached locally in
`~/.salesforce-mcp-bridge/`.

## Why this exists

The Salesforce Hosted MCP gateway at `api.salesforce.com` currently has
two interoperability gaps that block standards-compliant MCP clients:

1. **Broken OAuth discovery.** `/.well-known/oauth-protected-resource`
   advertises an authorization server that doesn't publish any
   `/.well-known/oauth-authorization-server` metadata — any client
   following the MCP 2025-03-26 auth flow (including `mcp-remote` and
   Claude Connectors) fails discovery and hangs or errors out.
2. **SID tokens rejected.** The gateway accepts only JWT-format access
   tokens (`"JWT Token is required"`), while the org's default OAuth
   flow issues opaque SID tokens unless "Issue JWT-based access tokens
   for named users" is explicitly enabled on the External Client App.

This bridge bypasses both by (a) doing OAuth on the org's own endpoints
and (b) storing and forwarding JWT tokens. Once Salesforce fixes the
discovery metadata, this bridge becomes superfluous.

## Prerequisites

- **Node.js ≥ 20**
- A Salesforce org with Hosted MCP Servers enabled (Setup → MCP Servers)
- An **External Client App** in the org, configured with:
  - OAuth scopes: `mcp_api`, `refresh_token`
  - Callback URL: `http://localhost:8765/oauth/callback` (or your chosen port)
  - Security → **Issue JSON Web Token (JWT)-based access tokens for named users** → ✅
  - Security → **Require Proof Key for Code Exchange (PKCE)** → ✅ (recommended)
  - PKCE enabled on supported auth flows

## Setup

```bash
git clone https://github.com/idcapture/salesforce-mcp-bridge.git
cd salesforce-mcp-bridge

# Configure via env vars...
export SF_ORG_DOMAIN='acme.my.salesforce.com'
export SF_CLIENT_ID='3MVG9…'          # Consumer Key from your ECA
export SF_CLIENT_SECRET='…'           # Consumer Secret from your ECA
# ...or via ~/.salesforce-mcp-bridge/config.json:
#   { "orgDomain": "...", "clientId": "...", "clientSecret": "..." }
# ...or with the secret in ~/.salesforce-mcp-bridge/secret (chmod 600)

# One-off login — opens your browser, completes OAuth, caches tokens.
npm run auth
```

Tokens are stored in `~/.salesforce-mcp-bridge/tokens.json` (chmod 600).
The refresh token is long-lived; you should not need to re-run `auth`
regularly.

## Wiring into clients

### Claude Code

```bash
claude mcp add salesforce --scope user -- node /absolute/path/to/salesforce-mcp-bridge/server.mjs
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "salesforce": {
      "command": "node",
      "args": ["/absolute/path/to/salesforce-mcp-bridge/server.mjs"]
    }
  }
}
```

Quit Claude Desktop completely (⌘Q — not just close the window) and
relaunch.

### Cursor / Windsurf / any stdio MCP client

Same shape as Claude Desktop — point the client at `node
/path/to/server.mjs`.

## Smoke test without a client

```bash
(
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  sleep 1
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 2
) | node server.mjs
```

You should see two JSON responses: an `initialize` reply, then the list
of tools exposed by the Hosted MCP server you selected.

## Configuration reference

| Env var              | Config key       | Default                    | Notes |
|----------------------|------------------|----------------------------|-------|
| `SF_ORG_DOMAIN`      | `orgDomain`      | —                          | **Required.** e.g., `acme.my.salesforce.com` |
| `SF_CLIENT_ID`       | `clientId`       | —                          | **Required.** External Client App Consumer Key |
| `SF_CLIENT_SECRET`   | `clientSecret`   | —                          | **Required** (or via `~/.salesforce-mcp-bridge/secret`) |
| `SF_MCP_SERVER`      | `server`         | `platform/sobject-reads`   | e.g., `platform/sobject-all` for read+write |
| `SF_CALLBACK_PORT`   | `callbackPort`   | `8765`                     | Must match a Callback URL in the ECA |
| `SF_SCOPES`          | `scopes`         | `mcp_api refresh_token`    | Space-separated OAuth scopes |
| `SF_STATE_DIR`       | —                | `~/.salesforce-mcp-bridge` | Token/config storage |

Config lookup order for each value: env var → `~/.salesforce-mcp-bridge/config.json` → default (or throw if required).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Not authenticated. Run: npm run auth` | No `tokens.json` yet | Run `npm run auth` |
| OAuth error `OAUTH_APPROVAL_ERROR_GENERIC` | Requested scope not granted on the ECA | Ensure `mcp_api` and `refresh_token` are in the ECA's selected scopes |
| Browser returns `invalid_request redirect_uri` | Callback URL missing from ECA | Add `http://localhost:8765/oauth/callback` (or your port) to the ECA's Callback URLs |
| Auth OK but tool calls return `401 Invalid token` | Tokens are opaque SIDs, not JWTs | Enable **Issue JWT-based access tokens for named users** in the ECA's Security section, then `rm ~/.salesforce-mcp-bridge/tokens.json && npm run auth` |
| `"empty serverURI"` from the gateway | Using a My Domain URL variant that the gateway doesn't resolve | Keep the short form — the bridge constructs it automatically from `SF_MCP_SERVER` |
| Port 8765 already in use | Another process listening | `SF_CALLBACK_PORT=8766 npm run auth` and add the new URL to the ECA's Callbacks |

## Security notes

- The Consumer Secret is stored either in an env var or in
  `~/.salesforce-mcp-bridge/secret` (chmod 600). Never commit it.
- Tokens live in `~/.salesforce-mcp-bridge/tokens.json` (chmod 600),
  per user, outside the repo.
- The bridge only opens a callback port during the one-off auth flow —
  not while serving MCP traffic.
- If you use the `sobject-all` server, Claude can create/update/delete
  records. Restrict with Profile/Permission Set in Salesforce.

## Limitations

- Single-user: one `tokens.json` per machine user.
- Bridges stdio only — no SSE/HTTP transport mode.
- Locked to the MCP `2024-11-05` protocol version; bump if your server advertises a newer one.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

This is a workaround for a Salesforce-side interop gap. If Salesforce
fixes the OAuth metadata on `api.salesforce.com`, this bridge becomes
unnecessary and direct use of `mcp-remote` or Claude Connectors will
work natively. PRs welcome in the meantime, especially:

- Support for the Streamable HTTP session lifecycle
- Dynamic Client Registration fallback
- OIDC/JWT refresh with RFC 8707 audience binding if/when Salesforce honors it
