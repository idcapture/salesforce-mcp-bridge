#!/usr/bin/env node
// Interactive authentication entry point.
// Run once: `npm run auth` — opens the browser, completes OAuth, writes tokens.

import { interactiveLogin } from './oauth.mjs';

try {
  const t = await interactiveLogin();
  console.error('[sf-bridge/auth] ✅ Access token length:', t.access_token?.length);
  console.error('[sf-bridge/auth] ✅ Refresh token present:', Boolean(t.refresh_token));
  console.error('[sf-bridge/auth] ✅ Instance URL:', t.instance_url);
  console.error('[sf-bridge/auth] ✅ Scope:', t.scope);
  console.error('[sf-bridge/auth] Done. You can now configure your MCP client to use server.mjs.');
  process.exit(0);
} catch (e) {
  console.error('[sf-bridge/auth] ❌', e.message);
  process.exit(1);
}
