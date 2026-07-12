#!/bin/bash
# Build a self-contained, drag-to-install DMG.
#
# Universal binary (Apple Silicon + Intel), ad-hoc signed so it launches
# without a "damaged" error, packaged with an /Applications symlink for
# drag-install. Electron is bundled — the browser and all color-correction
# features need no external dependencies. (The optional i1 hardware-probe
# feature still needs ArgyllCMS; everything else works standalone.)
set -euo pipefail

cd "$(dirname "$0")/.."
APP_NAME="Kootenay Browser"
OUT="out"
STAGE="$OUT/dmg-stage"
DMG="$OUT/${APP_NAME// /-}.dmg"
APP="$OUT/${APP_NAME}-darwin-universal/${APP_NAME}.app"

echo "▸ building…"
npm run build >/dev/null

echo "▸ packaging universal .app (downloads x64 + arm64 Electron on first run)…"
npx electron-packager . "$APP_NAME" \
  --platform=darwin --arch=universal --out="$OUT" --overwrite \
  --app-bundle-id=com.kootenay.browser --icon=build/icon \
  --ignore="^/(src|scripts|out|\.git|node_modules/\.cache|test)" >/dev/null

echo "▸ ad-hoc signing…"
codesign --deep --force --sign - "$APP"

echo "▸ staging…"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

echo "▸ creating DMG…"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG" >/dev/null

rm -rf "$STAGE"
SIZE=$(du -h "$DMG" | cut -f1)
echo "✓ $DMG ($SIZE)"
