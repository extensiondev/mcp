#!/usr/bin/env bash
# ███╗   ███╗ ██████╗██████╗
# ████╗ ████║██╔════╝██╔══██╗
# ██╔████╔██║██║     ██████╔╝
# ██║╚██╔╝██║██║     ██╔═══╝
# ██║ ╚═╝ ██║╚██████╗██║
# ╚═╝     ╚═╝ ╚═════╝╚═╝
# Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators
set -euo pipefail

PKG="${PKG:?PKG names the npm package}"
VERSION="${VERSION:?VERSION names the published version}"
INPUT="$(echo "${RELEASE_COMMIT:-}" | xargs)"
MAIN_REF="${MAIN_REF:-origin/main}"

GIT_HEAD="$(npm view "$PKG@$VERSION" gitHead --registry https://registry.npmjs.org/ 2>/dev/null | tail -n 1 | xargs || true)"

resolve() {
  git rev-parse --verify --quiet "$1^{commit}" || true
}

if [ -z "$INPUT" ] && [ -z "$GIT_HEAD" ]; then
  echo "::error::$PKG@$VERSION is on npm but this run cannot tell which commit its tarball was built from, so it tags nothing rather than main's head." >&2
  echo "Supply the commit either way: run the workflow again with release_commit set to the commit scripts/stage-release.sh printed, or publish with a gitHead in package.json (scripts/stage-release.sh writes it) so npm view $PKG@$VERSION gitHead answers it." >&2
  exit 1
fi

if [ -n "$INPUT" ]; then
  COMMIT="$(resolve "$INPUT")"
  SOURCE="the release_commit input"
  if [ -z "$COMMIT" ]; then
    echo "::error::release_commit $INPUT is not a commit in this repository. Push the commit $PKG@$VERSION was built from, or pass the one scripts/stage-release.sh printed." >&2
    exit 1
  fi
  if [ -n "$GIT_HEAD" ]; then
    RECORDED="$(resolve "$GIT_HEAD")"
    if [ "$RECORDED" != "$COMMIT" ]; then
      echo "::error::release_commit $INPUT and the gitHead npm recorded for $PKG@$VERSION ($GIT_HEAD) are different commits; the tag must name the tree npm serves, so check which one built it and pass that one." >&2
      exit 1
    fi
  fi
else
  COMMIT="$(resolve "$GIT_HEAD")"
  SOURCE="the gitHead npm recorded"
  if [ -z "$COMMIT" ]; then
    echo "::error::npm recorded gitHead $GIT_HEAD for $PKG@$VERSION, which is not a commit in this repository. Push it, or run the workflow again with release_commit set to the commit the tarball was built from." >&2
    exit 1
  fi
fi

SHORT="$(git rev-parse --short "$COMMIT")"
AHEAD="$(git log --format='%h %s' "$COMMIT..$MAIN_REF" 2>/dev/null || true)"

emit_summary() {
  echo "### $PKG@$VERSION was built from $SHORT"
  echo
  echo "Read from $SOURCE. The release commit and tag v$VERSION are cut on $SHORT, so the tag, the GitHub release and the npm tarball are one tree."
  if [ -n "$AHEAD" ]; then
    echo
    echo "$MAIN_REF holds $(printf '%s\n' "$AHEAD" | wc -l | xargs) commit(s) the published tarball lacks. They are not in v$VERSION and ship in the next version:"
    echo
    printf '%s\n' "$AHEAD" | sed 's/^/- /'
  fi
}

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  emit_summary >> "$GITHUB_STEP_SUMMARY"
else
  emit_summary
fi

if [ -n "$AHEAD" ]; then
  echo "::warning::$MAIN_REF moved past $SHORT; v$VERSION is cut on $SHORT and leaves out: $(printf '%s\n' "$AHEAD" | cut -d' ' -f1 | xargs)"
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "commit=$COMMIT"
    if [ -n "$AHEAD" ]; then echo "main_moved=true"; else echo "main_moved=false"; fi
  } >> "$GITHUB_OUTPUT"
fi
echo "commit=$COMMIT"
