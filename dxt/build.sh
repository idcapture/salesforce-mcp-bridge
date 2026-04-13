#!/usr/bin/env bash
# Build salesforce-mcp-bridge.dxt from the bridge source files.
# Output: dxt/dist/salesforce-mcp-bridge.dxt (zip with .dxt extension)

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
dist="$here/dist"
staging="$here/.staging"

rm -rf "$staging" "$dist"
mkdir -p "$staging/server" "$dist"

# Copy bridge source
cp "$root/server.mjs" "$staging/server/server.mjs"
cp "$root/oauth.mjs"  "$staging/server/oauth.mjs"
cp "$root/config.mjs" "$staging/server/config.mjs"

# Manifest at the root of the zip
cp "$here/manifest.json" "$staging/manifest.json"

# Minimal package.json so Node finds it's an ESM project
cat > "$staging/package.json" <<'EOF'
{
  "name": "salesforce-mcp-bridge-dxt",
  "version": "0.1.0",
  "type": "module",
  "private": true
}
EOF

# Bundle
dxt_name="salesforce-mcp-bridge-$(node -e "console.log(require('$here/manifest.json').version)").dxt"
out="$dist/$dxt_name"

(cd "$staging" && zip -r "$out" . -x '*.DS_Store' > /dev/null)

echo "Built: $out"
echo "Size: $(du -h "$out" | cut -f1)"
echo
echo "Contents:"
unzip -l "$out" | head -20
