#!/bin/bash
# Publish a new release that existing installs will auto-update to.
#
#   npm run publish -- <version> ["release notes"]
#   e.g.  npm run publish -- 0.2.0 "Fixes probe drift gate; new bookmarks page"
#
# Steps: bump package.json to <version>, build the universal app + DMG, zip the
# .app (what the in-app updater downloads), and create the GitHub release with
# both assets. The updater compares this tag against the running version, so the
# bundled version MUST equal the tag — this script keeps them in sync.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: publish_release.sh <version> [notes]}"
NOTES="${2:-Release $VERSION}"
APP_NAME="Kootenay Browser"
SLUG="$(node -p "require('./package.json').updateRepo")"
UNIVERSAL_APP="out/${APP_NAME}-darwin-universal/${APP_NAME}.app"
ZIP="out/Kootenay-Browser-${VERSION}-mac.zip"
DMG="out/Kootenay-Browser.dmg"

if [ "$SLUG" = "OWNER/REPO" ]; then
  echo "✗ Set \"updateRepo\": \"owner/name\" in package.json first." >&2
  exit 1
fi
command -v gh >/dev/null || { echo "✗ Install GitHub CLI: brew install gh" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "✗ Run: gh auth login" >&2; exit 1; }

echo "▸ bumping package.json → $VERSION"
node -e "const f='package.json',p=require('./'+f);p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"

echo "▸ building universal .app + DMG…"
npm run dmg >/dev/null

echo "▸ zipping .app for the updater…"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$UNIVERSAL_APP" "$ZIP"

echo "▸ committing + tagging…"
git add package.json
git commit -m "Release v$VERSION" >/dev/null || true

echo "▸ creating GitHub release v$VERSION on $SLUG…"
gh release create "v$VERSION" "$ZIP" "$DMG" \
  --repo "$SLUG" --title "v$VERSION" --notes "$NOTES" --target "$(git rev-parse --abbrev-ref HEAD)"

echo "✓ Published v$VERSION"
echo "  Installed copies will offer this update within a day (or via"
echo "  Kootenay Browser → Check for Updates…). New users: the DMG asset."
