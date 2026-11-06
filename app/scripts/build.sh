#!/bin/sh
# Builds build/Genlock.app from source. Needs Xcode or the Xcode command line tools.
set -eu
cd "$(dirname "$0")/.."

# When this build began, so a change made while it runs still counts as newer.
BUILT_AT=$(date +%s)

swift build -c release
BIN="$(swift build -c release --show-bin-path)"

APP=build/Genlock.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/Genlock" "$APP/Contents/MacOS/Genlock"
cp "$BIN/genlock-host" "$APP/Contents/MacOS/genlock-host"
for bundle in "$BIN"/*.bundle; do
  [ -e "$bundle" ] && cp -R "$bundle" "$APP/Contents/Resources/"
done

# The command-line tool and the node to run it travel with the app, so they always match it and
# nobody has to install anything. See ToolEnvironment.
CLI="$APP/Contents/Resources/genlock"
mkdir -p "$CLI"
for item in bin lib agent skills docs install.mjs package.json LICENSE; do cp -R "../$item" "$CLI/"; done
mkdir -p "$CLI/run"
cat > "$CLI/run/genlock" <<'SHIM'
#!/bin/sh
# Runs the genlock inside this app, with its own node when it has one.
here=$(cd "$(dirname "$0")" && pwd)
node="$here/../../../MacOS/node"
[ -x "$node" ] || node=node
exec "$node" "$here/../bin/genlock.mjs" "$@"
SHIM
chmod +x "$CLI/run/genlock"
NODE=$(command -v node || true)
if [ -n "$NODE" ]; then cp -L "$NODE" "$APP/Contents/MacOS/node"; fi

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
  <key>NSHumanReadableCopyright</key><string>Genlock™ is a trademark of TJ Loughlin. © 2026 TJ Loughlin.</string>
  <key>NSMicrophoneUsageDescription</key><string>Genlock listens when you press the mic button, so you can talk to your agent.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Genlock turns what you say into a message for your agent.</string>
</dict>
</plist>
PLIST

# Where this build came from, so the app can rebuild itself when its source changes.
# An integer, because a plist real holds this few digits only to the nearest 128 seconds.
/usr/libexec/PlistBuddy -c "Add :GenlockSourceRoot string $(pwd)" -c "Add :GenlockBuiltAt integer $BUILT_AT" "$APP/Contents/Info.plist"

# macOS ties granted permissions to the signature. Ad hoc changes with every build and asks again,
# so use a real identity when this Mac has one.
IDENTITY=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development[^"]*\)".*/\1/p' | head -1)
codesign --force --deep --sign "${IDENTITY:--}" "$APP"
echo "Built $(pwd)/$APP"
