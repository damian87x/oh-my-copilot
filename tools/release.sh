#!/usr/bin/env bash
set -euo pipefail

# release.sh — cut, tag, and publish a new @damian87/omp release.
#
# Maintainer tool (NOT a plugin skill / not in the catalog). Runs the full
# release flow so you don't repeat the steps by hand each time.
#
# Usage (prefer the npm wrappers):
#   npm run release -- <patch|minor|major> [--otp <code>] [--dry-run] [--no-gh] [--no-publish]
#   npm run release:publish-only -- [--otp <code>]   # build + npm publish the CURRENT version
#
#   tools/release.sh <patch|minor|major> [--otp <code>] [--dry-run] [--no-gh] [--no-publish]
#   tools/release.sh --publish-only [--otp <code>]
#
# Examples:
#   npm run release -- minor --otp 123456          # bump 0.x.0, tag, push, gh release, npm publish
#   npm run release -- patch --dry-run             # validate everything, change nothing
#   npm run release:publish-only -- --otp 123456   # finish a release whose tag already exists
#
# npm has 2FA on this package, so pass --otp <6-digit-code> from your authenticator
# (or omit it and npm will prompt interactively).

BUMP=""
OTP=""
DRY=false
DO_GH=true
DO_PUBLISH=true
PUBLISH_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major) BUMP="$1"; shift ;;
    --publish-only)    PUBLISH_ONLY=true; shift ;;
    --otp)             OTP="${2:-}"; shift 2 ;;
    --otp=*)           OTP="${1#*=}"; shift ;;
    --dry-run)         DRY=true; shift ;;
    --no-gh)           DO_GH=false; shift ;;
    --no-publish)      DO_PUBLISH=false; shift ;;
    -h|--help)
      grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

npm_publish() {
  if [[ -n "$OTP" ]]; then
    npm publish --access public --otp="$OTP"
  else
    npm publish --access public
  fi
}

# --- publish-only: build the current version and publish (recovery / OTP retry) ---
if $PUBLISH_ONLY; then
  echo "→ publish-only: building current version $(node -p "require('./package.json').version")"
  npm run build
  if $DRY; then npm publish --dry-run --access public; else npm_publish; fi
  echo "✓ published $(node -p "require('./package.json').version")"
  exit 0
fi

[[ -z "$BUMP" ]] && { echo "Usage: npm run release -- <patch|minor|major> [--otp <code>] [--dry-run] [--no-gh] [--no-publish]" >&2; exit 1; }

# --- guards ---
branch="$(git branch --show-current)"
[[ "$branch" == "main" ]] || { echo "✗ must be on main (currently on '$branch')" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "✗ working tree is not clean" >&2; exit 1; }
git fetch -q origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || { echo "✗ local main is not in sync with origin/main" >&2; exit 1; }

# --- quality gates (these also build) ---
echo "→ running quality gates"
npm test
npm run lint:skills
npm run check:catalog
npm run build

if $DRY; then
  NEXT="$(node -e "const s=require('semver');" 2>/dev/null && node -p "require('semver').inc(require('./package.json').version,'$BUMP')" 2>/dev/null || echo '<next>')"
  echo "[dry-run] would: npm version $BUMP → $NEXT, sync plugin.json → $NEXT, commit + tag, push --follow-tags, gh release, npm publish, verify npm at $NEXT"
  npm publish --dry-run --access public
  exit 0
fi

# --- bump + tag (commit message matches the repo convention) ---
# Bump package.json without committing so plugin.json can ride along in the
# same release commit (keeps the Copilot plugin manifest version in sync).
echo "→ bumping version ($BUMP)"
npm version "$BUMP" --no-git-tag-version
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"

echo "→ syncing plugin.json to $VERSION"
node -e "const fs=require('fs');const p=require('./plugin.json');p.version='$VERSION';fs.writeFileSync('./plugin.json',JSON.stringify(p,null,2)+'\n')"

git add package.json package-lock.json plugin.json
git commit -m "chore: release v$VERSION"
git tag "$TAG"

echo "→ pushing main + tag $TAG"
git push origin main --follow-tags

if $DO_GH; then
  echo "→ creating GitHub release $TAG"
  gh release create "$TAG" --title "$TAG" --generate-notes \
    || echo "⚠ gh release failed/skipped — create it manually if needed"
fi

if $DO_PUBLISH; then
  echo "→ publishing to npm"
  npm run build
  npm_publish

  # Verify the publish actually landed — the registry can lag a few seconds.
  # This guards against the silent "tagged but never published" drift.
  echo "→ verifying npm registry advanced to $VERSION"
  PUBLISHED="none"
  for i in 1 2 3 4 5; do
    PUBLISHED="$(npm view @damian87/omp version 2>/dev/null || echo none)"
    [[ "$PUBLISHED" == "$VERSION" ]] && break
    sleep 3
  done
  [[ "$PUBLISHED" == "$VERSION" ]] || { echo "✗ npm still at $PUBLISHED, expected $VERSION — publish did NOT land" >&2; exit 1; }
  echo "✓ npm confirmed at $VERSION"
fi

echo "✓ released $TAG"
