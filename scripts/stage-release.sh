#!/usr/bin/env bash
# ███╗   ███╗ ██████╗██████╗
# ████╗ ████║██╔════╝██╔══██╗
# ██╔████╔██║██║     ██████╔╝
# ██║╚██╔╝██║██║     ██╔═══╝
# ██║ ╚═╝ ██║╚██████╗██║
# ╚═╝     ╚═╝ ╚═════╝╚═╝
# Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators
set -euo pipefail

VERSION="$(echo "${1:-}" | xargs)"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: scripts/stage-release.sh <version>, a plain semver version such as 10.22.1" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has changes. Stage from a clean checkout of the commit the Release run built from, so the tarball is exactly that commit plus the version bump." >&2
  git status --short >&2
  exit 1
fi

COMMIT="$(git rev-parse HEAD)"
git fetch --quiet origin main
if ! git merge-base --is-ancestor "$COMMIT" origin/main; then
  echo "$COMMIT is not on origin/main. The rerun tags the commit the tarball was built from, so it has to be pushed first." >&2
  exit 1
fi

PKG="$(node -p 'require("./package.json").name')"
ACCESS="$(node -p 'require("./package.json").publishConfig?.access || "public"')"

restore() {
  git checkout --quiet -- package.json server.json .claude-plugin docs/tools.json docs/clients.json docs/store-md-fields.json README.md
}
trap restore EXIT

node scripts/set-release-version.mjs "$VERSION"
npm pkg set "gitHead=$COMMIT"
pnpm compile

BUILT="$(node -e 'import("./dist/module.js").then((m) => process.stdout.write(String(m.version)))')"
if [ "$BUILT" != "$VERSION" ]; then
  echo "dist/module.js reports version ${BUILT:-<none>}, not $VERSION; the bundle was built from a stale tree" >&2
  exit 1
fi

node scripts/readme-logo-width.mjs npm
npm stage publish --provenance=false --access "$ACCESS" --tag latest --ignore-scripts

echo
echo "Staged $PKG@$VERSION built from $COMMIT (recorded as its gitHead)."
echo "Approve it with: npm stage approve <stage-id> (it asks for a one-time code)."
echo "Then run the Release workflow again with the same inputs and release_commit $COMMIT:"
echo "  gh workflow run release.yml -R extensiondev/mcp -f channel=stable -f version=$VERSION -f release_commit=$COMMIT"
