#!/bin/zsh
# Put the newest phone app online: upload the debug APK to the Cloudflare R2 bucket
# "genlock-builds" with a small download page, at an address that stays the same from build
# to build (bookmark it on the phone). The secret part of the address lives in ~/.genlock_ship,
# not the repo: anyone with the link can download the app, nobody can find it without it.
#   mobile/ship_android.sh [--build]     --build builds the APK first
#   mobile/ship_android.sh --setup       once: create the bucket and turn on its public r2.dev address
# Copied from ~/nightmaremode/game/tools/ship_android.sh. The APK is ~16 MB, far under Wrangler's
# 300 MiB limit, so it goes up directly, with no multipart Worker.
set -euo pipefail
here=${0:A:h}
root=${here:h}
apk=$here/android/app/build/outputs/apk/debug/app-debug.apk
bucket=genlock-builds
tokfile=$HOME/.genlock_ship
wr() { (cd $HOME && npx --no-install wrangler "$@") }   # wrangler is installed for the user, not this repo

if [[ "${1:-}" == "--setup" ]]; then
  wr r2 bucket create $bucket || true
  wr r2 bucket dev-url enable $bucket --force
  exit 0
fi
if [[ "${1:-}" == "--build" ]]; then
  # The Android build needs JDK 17; a JAVA_HOME already set in the shell is often 8 or 11.
  [[ -d $HOME/dev-tools/jdk17/Contents/Home ]] && export JAVA_HOME=$HOME/dev-tools/jdk17/Contents/Home
  (cd $here/android && ./gradlew assembleDebug -q)
fi
[[ -f $apk ]] || { echo "no APK: run mobile/ship_android.sh --build"; exit 1; }
public=$(wr r2 bucket dev-url get $bucket 2>&1 | grep -o 'https://pub-[a-z0-9]*\.r2\.dev' | head -1 || true)
[[ -n $public ]] || { echo "bucket $bucket has no public address: run mobile/ship_android.sh --setup"; exit 1; }

# Upload a private snapshot, never build/ itself: a build running in another session can rewrite
# the APK mid-upload and put a broken file online. The snapshot must be a whole zip.
snap=$(mktemp -t ship_apk).apk
page=$(mktemp -t ship).html
trap 'rm -f $snap $page' EXIT
cp $apk $snap
unzip -tq $snap >/dev/null 2>&1 || { echo "APK is incomplete (still building?): try again in a minute"; exit 1; }
bytes=$(stat -f %z $snap)
meta=${apk:h}/output-metadata.json
version=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["elements"][0]["versionName"])' $meta 2>/dev/null || echo "?")

[[ -f $tokfile ]] || { python3 -c 'import secrets;print(secrets.token_urlsafe(24))' > $tokfile; chmod 600 $tokfile; }
tok=$(cat $tokfile)
stamp=$(date "+%Y-%m-%d %H:%M")
commit=$(git -C $root log -1 --format=%h)
size=$(du -h $snap | cut -f1 | tr -d ' ')
cat > $page <<EOF
<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Genlock for Android</title>
<style>body{background:#1a1b26;color:#c0caf5;font:18px/1.5 system-ui;margin:0;padding:32px 20px;text-align:center}
h1{font-weight:650;letter-spacing:.02em}a{display:inline-block;margin:24px 0;padding:18px 34px;background:#7aa2f7;color:#1a1b26;
border-radius:12px;text-decoration:none;font-weight:700;font-size:20px}small{color:#9aa5ce}</style>
<h1>Genlock</h1>
<p>Newest build: <b>$stamp</b><br>version $version ($commit, $size)</p>
<a href="genlock.apk?v=$version">Download for Android</a>
<p><small>Open the download and tap Install (the first time, allow installs from your browser).<br>
Installing over the old version keeps your pairing.</small></p>
EOF
wr r2 object put "$bucket/$tok/genlock.apk" --file $snap --remote \
  --content-type application/vnd.android.package-archive
wr r2 object put "$bucket/$tok/index.html" --file $page --remote \
  --content-type "text/html; charset=utf-8" --cache-control no-cache
online=$(curl -sI "$public/$tok/genlock.apk?v=$version" | awk 'tolower($1)=="content-length:"{print $2+0}')
[[ $online == $bytes ]] || { echo "upload check FAILED: online $online bytes, expected $bytes"; exit 1; }
echo "Shipped: $public/$tok/index.html (version $version, $bytes bytes, checked online)"
