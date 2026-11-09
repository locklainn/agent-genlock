#!/usr/bin/env bash
#
# Put the newest Android build online, behind a link that never changes.
# All app-specific values come from phone.conf beside this script.
# ------------------------------------------------------------
#     ./ship.sh            build a fresh release APK (./phone.sh android --build-only), then upload it
#     ./ship.sh --no-build upload dist/$APP_SLUG.apk as it is
#
# Uploads the APK and a small download page to a Cloudflare R2 bucket. The address stays the
# same from build to build, so people bookmark it once: open it, tap Download, tap Install
# (the first time Android asks to allow installs from the browser). Installing over the old
# copy keeps their data, as long as every build is signed with the same key.
#
# The secret part of the address lives in $SHIP_TOKEN_FILE, never in the repo: anyone with
# the link can download the app, nobody can find it without it (r2.dev serves no listing).
# To revoke every link handed out so far, delete that file and ship again.
#
# iPhones cannot install from a link: Apple allows that only through TestFlight or an
# ad-hoc build, both of which need the paid ($99/yr) developer account.
# ------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"
root=$PWD
# shellcheck disable=SC1091
. ./phone.conf
apk=$root/dist/$APP_SLUG.apk

case "${1:-}" in
  --no-build) ;;
  "") ./phone.sh android --build-only ;;
  *) echo "usage: ./ship.sh [--no-build]"; exit 2 ;;
esac
[ -f "$apk" ] || { echo "No APK: run ./phone.sh android --build-only first"; exit 1; }

# Upload a private snapshot, never dist/ itself: a build started in another terminal can
# rewrite the APK mid-upload and put a broken file online (nightmaremode, 2026-11-08).
work=$(mktemp -d -t "${APP_SLUG}_ship")
trap 'rm -rf "$work"' EXIT
cp "$apk" "$work/$APP_SLUG.apk"
unzip -tq "$work/$APP_SLUG.apk" >/dev/null 2>&1 || { echo "APK is incomplete (still building?): try again in a minute"; exit 1; }
bytes=$(stat -f %z "$work/$APP_SLUG.apk")
size=$(du -h "$work/$APP_SLUG.apk" | cut -f1 | tr -d ' ')

[ -f "$SHIP_TOKEN_FILE" ] || python3 -c 'import secrets;print(secrets.token_urlsafe(24))' > "$SHIP_TOKEN_FILE"
tok=$(cat "$SHIP_TOKEN_FILE")
stamp=$(date "+%Y-%m-%d %H:%M")
commit=$(git log -1 --format=%h 2>/dev/null || echo "no git")
[ -n "$(git status --porcelain --untracked-files=no 2>/dev/null | head -1)" ] && commit="$commit+local changes"
v=$(date +%s)

cat > "$work/index.html" <<EOF
<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>$APP_NAME</title>
<style>body{background:#0b1020;color:#e6e8f2;font:18px/1.5 system-ui;margin:0;padding:32px 20px;text-align:center}
h1{letter-spacing:.08em;color:#c7cbff}a.b{display:inline-block;margin:24px 0;padding:18px 34px;background:#818cf8;color:#0b1020;
border-radius:12px;text-decoration:none;font-weight:700;font-size:20px}small{color:#8b90a8}</style>
<h1>$APP_NAME</h1>
<p>Newest build: <b>$stamp</b><br><small>$commit · $size</small></p>
<a class="b" href="$APP_SLUG.apk?v=$v">Download for Android</a>
<p><small>Open the download and tap Install. The first time, Android asks you to allow<br>
installs from your browser. Installing over the old version keeps everything you have.</small></p>
<p><small>iPhone: not available from a link yet. Ask $OWNER.</small></p>
EOF

info() { printf "\033[36m%s\033[0m\n" "$1"; }
info "== Uploading $size to R2 ($R2_BUCKET)"
# The page goes last, so it never points at an APK that isn't there yet.
cd "$WRANGLER_DIR"
npx --no-install wrangler r2 object put "$R2_BUCKET/$tok/$APP_SLUG.apk" --file "$work/$APP_SLUG.apk" --remote \
  --content-type application/vnd.android.package-archive --cache-control no-cache >/dev/null
npx --no-install wrangler r2 object put "$R2_BUCKET/$tok/index.html" --file "$work/index.html" --remote \
  --content-type "text/html; charset=utf-8" --cache-control no-cache >/dev/null

# Prove it from the outside: the bytes online are this build's, and so is the page.
online=$(curl -sI "$R2_PUBLIC/$tok/$APP_SLUG.apk?v=$v" | awk 'tolower($1)=="content-length:"{print $2+0}')
[ "$online" = "$bytes" ] || { echo "Upload check FAILED: online ${online:-nothing}, expected $bytes bytes"; exit 1; }
curl -sf "$R2_PUBLIC/$tok/index.html" | grep -q "$stamp" || { echo "Upload check FAILED: the page online is not this build's"; exit 1; }
echo "Shipped: $R2_PUBLIC/$tok/index.html ($bytes bytes, checked online)"
