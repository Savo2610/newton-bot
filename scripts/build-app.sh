#!/bin/bash
# Baut NewtonBot.app (macOS) nach dist/ und optional ein Zip fürs GitHub-Release.
#   scripts/build-app.sh            -> dist/NewtonBot.app
#   scripts/build-app.sh --zip      -> zusätzlich dist/NewtonBot-mac.zip
#   scripts/build-app.sh --install  -> zusätzlich nach ~/Applications kopieren
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VERSION="$(node -p "require('./package.json').version")"
APP="$ROOT/dist/NewtonBot.app"
C="$APP/Contents"

rm -rf "$APP"
mkdir -p "$C/MacOS" "$C/Resources/bot"

# Bot-Code ins Bundle
cp -R src public package.json LICENSE "$C/Resources/bot/"

# Starter
cp scripts/launcher.sh "$C/MacOS/NewtonBot"
chmod +x "$C/MacOS/NewtonBot"

# Icon aus assets/icon.svg (Quick Look rendert SVG)
TMP="$(mktemp -d)"
qlmanage -t -s 1024 -o "$TMP" assets/icon.svg >/dev/null 2>&1
SET="$TMP/AppIcon.iconset"; mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.svg.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$TMP/icon.svg.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$C/Resources/AppIcon.icns"
rm -rf "$TMP"

cat > "$C/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>NewtonBot</string>
  <key>CFBundleDisplayName</key><string>NewtonBot</string>
  <key>CFBundleIdentifier</key><string>io.github.savo2610.newtonbot</string>
  <key>CFBundleExecutable</key><string>NewtonBot</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT License · based on NewtonWars by Manuel Kasten</string>
</dict>
</plist>
PLIST

# Ad-hoc-Signatur (verhindert "beschädigt"-Meldungen auf Apple Silicon)
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "✓ $APP (v$VERSION)"

for arg in "$@"; do
  case "$arg" in
    --zip)
      rm -f "$ROOT/dist/NewtonBot-mac.zip"
      ditto -c -k --keepParent "$APP" "$ROOT/dist/NewtonBot-mac.zip"
      echo "✓ dist/NewtonBot-mac.zip" ;;
    --install)
      mkdir -p "$HOME/Applications"
      rm -rf "$HOME/Applications/NewtonBot.app"
      cp -R "$APP" "$HOME/Applications/"
      echo "✓ installiert: ~/Applications/NewtonBot.app" ;;
  esac
done
