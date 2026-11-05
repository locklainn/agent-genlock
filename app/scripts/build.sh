#!/bin/sh
# Builds build/Genlock.app from source. Needs Xcode or the Xcode command line tools.
set -eu
cd "$(dirname "$0")/.."

swift build -c release
BIN="$(swift build -c release --show-bin-path)"

APP=build/Genlock.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/Genlock" "$APP/Contents/MacOS/Genlock"
for bundle in "$BIN"/*.bundle; do
  [ -e "$bundle" ] && cp -R "$bundle" "$APP/Contents/Resources/"
done

swift scripts/make-icon.swift build/Genlock.iconset >/dev/null
iconutil -c icns build/Genlock.iconset -o "$APP/Contents/Resources/Genlock.icns"
rm -rf build/Genlock.iconset

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Genlock</string>
  <key>CFBundleDisplayName</key><string>Genlock</string>
  <key>CFBundleIdentifier</key><string>com.locklainn.genlock</string>
  <key>CFBundleExecutable</key><string>Genlock</string>
  <key>CFBundleIconFile</key><string>Genlock</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Genlock listens when you press the mic button, so you can talk to your agent.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Genlock turns what you say into a message for your agent.</string>
</dict>
</plist>
PLIST

# Ad hoc signed, so macOS can remember the permissions you grant it on this Mac.
codesign --force --deep --sign - "$APP"
echo "Built $(pwd)/$APP"
