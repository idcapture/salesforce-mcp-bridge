# IDCapture Salesforce MCP Bridge

Stdio MCP bridge to the Salesforce Hosted MCP server (`sobject-reads`) for the
IDCapture org. Works around the current Salesforce bug where OAuth discovery
metadata on `api.salesforce.com` is unreachable from `mcp-remote` and Claude
Connectors.

## What it does

```
Claude Desktop / Claude Code
     │  (stdio JSON-RPC 2.0)
     ▼
server.mjs (this bridge)
     │  (HTTPS + Bearer <access_token>)
     ▼
api.salesforce.com/platform/mcp/v1/d/idcapture/platform/sobject-reads
```

OAuth happens once, directly against `idcapture.my.salesforce.com/services/oauth2/authorize`
(the real auth server — the one `api.salesforce.com` advertises but doesn't serve metadata for).

## Prerequisites on the Salesforce side

In the External Client App `IDCapture MCP Client`:

1. **OAuth scopes** must include `mcp_api` and `refresh_token` (the hosted MCP
   rejects tokens without `mcp_api`). `api` and `id` are not needed.
2. **Callback URL** must include `http://localhost:8765/oauth/callback`.
3. Note the **Consumer Key** (non-secret, already embedded in `config.mjs`).
4. **Regenerate** the Consumer Secret (the previous one was leaked in chat).

## Setup

```bash
cd /Users/vcanuel/DEV/mcp/salesforce-bridge

# Store the consumer secret outside the repo, chmod 600
mkdir -p ~/.idcapture-salesforce-bridge
printf '%s' 'YOUR_NEW_CONSUMER_SECRET' > ~/.idcapture-salesforce-bridge/secret
chmod 600 ~/.idcapture-salesforce-bridge/secret

# One-off login — opens browser, writes tokens to ~/.idcapture-salesforce-bridge/tokens.json
npm run auth
```

## Wire it into Claude

### Claude Code

```bash
claude mcp add idcapture-salesforce \
  --scope user \
  -- node /Users/vcanuel/DEV/mcp/salesforce-bridge/server.mjs
```

### Claude Desktop

Add under `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
"idcapture-salesforce": {
  "command": "node",
  "args": ["/Users/vcanuel/DEV/mcp/salesforce-bridge/server.mjs"]
}
```

Restart Claude.

## Testing without Claude

```bash
# Initialize, then list tools
(
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
  sleep 1
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 2
) | node server.mjs
```

You should see an `initialize` response then a `tools/list` with the 6 sobject-reads tools.

## Troubleshooting

- **`Not authenticated. Run: npm run auth`** — no token file yet; run the auth step.
- **Bridge hangs during auth** — check that the Callback URL in the ECA exactly matches
  `http://localhost:8765/oauth/callback` (no trailing slash).
- **401 on every tool call** — the `mcp_api` scope is likely missing from the ECA.
  Refresh the token after fixing: `rm ~/.idcapture-salesforce-bridge/tokens.json && npm run auth`.
- **Switch to a different server** — set `SF_MCP_SERVER=platform/sobject-all`
  (or any other server shown in Setup → MCP Servers) in the env when launching.
