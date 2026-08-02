#!/usr/bin/env bash
set -euo pipefail

REGISTRY="${MCP_REGISTRY_URL:-https://registry.modelcontextprotocol.io}"
PUBLISHER_DIR="${RUNNER_TEMP:-/tmp}/mcp-publisher"

PKG_NAME="$(node -p 'require("./package.json").name')"
PKG_VERSION="$(node -p 'require("./package.json").version')"
PKG_MCP_NAME="$(node -p 'require("./package.json").mcpName || ""')"
SERVER_NAME="$(node -p 'require("./server.json").name')"
SERVER_VERSION="$(node -p 'require("./server.json").version')"

if [ "$SERVER_VERSION" != "$PKG_VERSION" ]; then
  echo "server.json says $SERVER_VERSION and package.json says $PKG_VERSION." >&2
  echo "The registry listing is what an agent reads before it installs anything, so it may never announce a version this repository is not shipping." >&2
  exit 1
fi

node -e '
  const server = require("./server.json");
  const expected = process.argv[1];
  for (const pkg of server.packages || []) {
    if (pkg.version !== expected) {
      console.error(`server.json packages[] entry ${pkg.identifier} pins ${pkg.version}, not ${expected}`);
      process.exit(1);
    }
  }
' "$PKG_VERSION"

if [ "$SERVER_NAME" != "$PKG_MCP_NAME" ]; then
  echo "server.json is named $SERVER_NAME but package.json mcpName is ${PKG_MCP_NAME:-<unset>}." >&2
  echo "The registry proves ownership of an npm package by reading mcpName off the published tarball; the two must agree or the publish is rejected." >&2
  exit 1
fi

echo "Waiting for npm to serve $PKG_NAME@$PKG_VERSION with mcpName $SERVER_NAME"
PUBLISHED_MCP_NAME=""
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  PUBLISHED_MCP_NAME="$(npm view "$PKG_NAME@$PKG_VERSION" mcpName --registry https://registry.npmjs.org/ 2>/dev/null || true)"
  if [ -n "$PUBLISHED_MCP_NAME" ]; then break; fi
  echo "  attempt $attempt: not visible yet, retrying in 15s"
  sleep 15
done

if [ "$PUBLISHED_MCP_NAME" != "$SERVER_NAME" ]; then
  echo "npm serves mcpName '${PUBLISHED_MCP_NAME:-<nothing>}' for $PKG_NAME@$PKG_VERSION, expected '$SERVER_NAME'." >&2
  echo "Publish the npm package first: the registry validates the listing against the tarball, and a listing that points at a version npm does not serve is worse than a stale one." >&2
  exit 1
fi

mkdir -p "$PUBLISHER_DIR"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
curl -fsSL "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${OS}_${ARCH}.tar.gz" \
  | tar xz -C "$PUBLISHER_DIR" mcp-publisher

"$PUBLISHER_DIR/mcp-publisher" login github-oidc
"$PUBLISHER_DIR/mcp-publisher" publish

echo "Reading the listing back from $REGISTRY"
curl -fsSL "$REGISTRY/v0/servers?search=$SERVER_NAME" > "$PUBLISHER_DIR/listing.json"
node -e '
  const fs = require("node:fs");
  const [file, name, version] = process.argv.slice(1);
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  const meta = "io.modelcontextprotocol.registry/official";
  const latest = (body.servers || []).find(
    (entry) => entry.server?.name === name && entry._meta?.[meta]?.isLatest,
  );
  if (!latest) {
    console.error(`${name} has no entry flagged isLatest in the registry response`);
    process.exit(1);
  }
  if (latest.server.version !== version) {
    console.error(
      `the registry still serves ${latest.server.version} as latest for ${name}, not ${version}`,
    );
    process.exit(1);
  }
  console.log(`${name} is live at ${version}: ${latest.server.description}`);
' "$PUBLISHER_DIR/listing.json" "$SERVER_NAME" "$PKG_VERSION"
