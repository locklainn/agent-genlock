#!/usr/bin/env bash
#
# Put a standalone release build on a phone you NAME, by cable or Wi-Fi.
# All app-specific values come from phone.conf beside this script.
# ------------------------------------------------------------
#     ./phone.sh --list                          the phones this Mac can see, and which are in reach
#     ./phone.sh --device pixel                  build and install on that phone only
#     ./phone.sh --device iphone --device pixel  several, installed in the order given
#     ./phone.sh --device pixel --install-only   reinstall the last build without rebuilding
#     ./phone.sh android --build-only            build dist/$APP_SLUG.apk, install nothing (./ship.sh uses this)
#     ./phone.sh ios --build-only                build the iPhone app, install nothing
#
# NOTHING IS INSTALLED ON A PHONE THAT WAS NOT NAMED. There is no "every phone in reach":
# being connected to a phone is not permission to put a build on it.
# --device matches the phone's name, model or id (case-insensitive, part of it is enough)
# and must match exactly one phone. Run in a terminal without --device, it shows a menu and
# you pick; run any other way (an agent, a script), it lists the phones and refuses.
# For agents there is a second, independent lock: the PreToolUse hook in
# .claude/hooks/phone-install-guard.mjs.
#
# A RELEASE build unless phone.conf sets ANDROID_VARIANT: the JS is baked in, so the phone
# runs it with this Mac off.
# Installing over an existing copy keeps everything on the phone (same app id, same key).
#
# "In reach" means paired with this Mac once, then on the same Wi-Fi:
#   Android  Developer options → Wireless debugging → "Pair device with pairing code",
#            then `adb pair IP:PORT CODE` here once. adb finds it on the network after that.
#   iPhone   Plug in once, tap Trust, Developer Mode on (Settings → Privacy & Security).
#            After that Xcode reaches it over Wi-Fi while it is UNLOCKED: a locked or
#            sleeping iPhone shows as "unavailable" and cannot be installed on.
# ------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"
root=$PWD
[ -f phone.conf ] || { echo "No phone.conf beside phone.sh"; exit 1; }
# shellcheck disable=SC1091
. ./phone.conf
dist=$root/dist

usage() { echo "usage: ./phone.sh --list | --device NAME [--device NAME..] [--install-only] | android|ios --build-only"; }
platform=""      # android | ios | "" (= whatever the named phones need)
mode=install     # install | build | list
buildstep=1
picks=()
while (( $# )); do
  case $1 in
    android|ios) platform=$1 ;;
    --list) mode=list ;;
    --build-only) mode=build ;;
    --install-only) buildstep=0 ;;
    --device) [ $# -ge 2 ] || { usage; exit 2; }; picks+=("$2"); shift ;;
    --device=*) picks+=("${1#--device=}") ;;
    *) usage; exit 2 ;;
  esac
  shift
done
mkdir -p "$dist"

info() { printf "\033[36m%s\033[0m\n" "$1"; }
warn() { printf "\033[33m%s\033[0m\n" "$1"; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ── The phones this Mac can see. One line each: platform|id|label|reach ─────────
phones() {
  local s model serial seen=" "
  if command -v adb >/dev/null; then
    adb start-server >/dev/null 2>&1; sleep 2   # a fresh adb server needs a moment to see Wi-Fi phones
    for s in $(adb devices | awk 'NR>1 && $2=="device" {print $1}'); do
      serial=$(adb -s "$s" shell getprop ro.serialno 2>/dev/null | tr -d '\r')
      [[ $seen == *" $serial "* ]] && continue    # one phone can be listed twice (cable and Wi-Fi)
      seen+="$serial "
      model=$(adb -s "$s" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
      echo "android|$s|$model ($serial)|in reach"
    done
  fi
  # devicectl columns are separated by runs of spaces; names can contain single spaces.
  # Test "unavailable" explicitly: /available/ also matches inside it.
  xcrun devicectl list devices 2>/dev/null | awk -F'  +' 'NR>2 && $5 ~ /iPhone|iPad/ {
    reach = ($4 ~ /unavailable/) ? "NOT in reach (locked, asleep or off the Wi-Fi)" : "in reach"
    m = $5; sub(/ \(.*/, "", m)
    print "ios|" $3 "|" $1 " — " m "|" reach }'
}

list_phones() {
  local p id label reach
  while IFS='|' read -r p id label reach; do
    printf "  %-8s %-30s %s\n            id: %s\n" "$p" "$label" "$reach" "$id"
  done
}

all=$(phones)
if [ -n "$platform" ]; then all=$(printf '%s\n' "$all" | awk -F'|' -v p="$platform" '$1==p'); fi

if [ "$mode" = list ]; then
  [ -n "$all" ] && printf '%s\n' "$all" | list_phones || echo "  (no phones paired with this Mac are visible)"
  exit 0
fi

# ── Which phones: named with --device, or picked from a menu by a person at a terminal ──
targets=()
if [ "$mode" = install ]; then
  if (( ${#picks[@]} == 0 )); then
    if [ -t 0 ] && [ -t 1 ] && [ -n "$all" ]; then
      echo "Which phone? (nothing is installed until you pick)"
      i=0; while IFS= read -r line; do i=$((i+1)); printf "  %d) %s\n" $i "$(echo "$line" | awk -F'|' '{print $1"  "$3"  ["$4"]"}')"; done <<< "$all"
      read -r -p "Number(s), in install order (e.g. 2 1), or Enter to cancel: " nums
      [ -n "$nums" ] || { echo "Cancelled. Nothing installed."; exit 2; }
      for n in $nums; do
        line=$(printf '%s\n' "$all" | sed -n "${n}p")
        [ -n "$line" ] || { echo "No phone $n. Nothing installed."; exit 2; }
        targets+=("$line")
      done
    else
      echo "Refusing: no phone named. Nothing is installed on a phone that was not chosen."
      echo "Phones this Mac can see:"
      [ -n "$all" ] && printf '%s\n' "$all" | list_phones || echo "  (none)"
      echo "Run again with --device NAME for the one(s) $OWNER chose."
      exit 2
    fi
  else
    for want in "${picks[@]}"; do
      w=$(lower "$want")
      # if/fi, not `[[ ]] && echo`: under set -e + pipefail a false last test kills the script.
      matches=$(printf '%s\n' "$all" | while IFS= read -r line; do
        [ -n "$line" ] || continue
        l=$(lower "$line"); if [[ $l == *"$w"* ]]; then echo "$line"; fi; done)
      n=$(printf '%s' "$matches" | grep -c . || true)
      if (( n == 0 )); then echo "No phone matches '$want'. Nothing installed. Phones:"; printf '%s\n' "$all" | list_phones; exit 2; fi
      if (( n > 1 )); then echo "'$want' matches $n phones — be more specific. Nothing installed:"; printf '%s\n' "$matches" | list_phones; exit 2; fi
      targets+=("$matches")
    done
  fi
  # Every chosen phone must be in reach, or nothing is installed anywhere: a half-done
  # "both" is not what was asked for.
  for t in "${targets[@]}"; do
    IFS='|' read -r p id label reach <<< "$t"
    [ "$reach" = "in reach" ] || { warn "$label is $reach. Unlock it on the same Wi-Fi and try again. Nothing installed."; exit 3; }
  done
fi

# Platforms to build: what the chosen phones need, or the one named for --build-only.
need_android=0 need_ios=0
if [ "$mode" = build ]; then
  case $platform in android) need_android=1 ;; ios) need_ios=1 ;; *) need_android=1; need_ios=1 ;; esac
else
  for t in "${targets[@]}"; do case ${t%%|*} in android) need_android=1 ;; ios) need_ios=1 ;; esac; done
fi

apk=$dist/$APP_SLUG.apk
iosdd=$root/ios/build/phone

build_android() {
  [ -d "$ANDROID_DIR" ] || { echo "No $ANDROID_DIR/ folder: generate the native project first."; return 1; }
  local jbr="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  if [ -n "${JDK_HOME:-}" ] && [ -x "$JDK_HOME/bin/java" ]; then export JAVA_HOME="$JDK_HOME"
  elif [ -x "$jbr/bin/java" ]; then export JAVA_HOME="$jbr"
  else export JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"; fi
  [ -n "${JAVA_HOME:-}" ] || { echo "Need a JDK 17+ (Android Studio bundles one)."; return 1; }
  # release by default. debug only when the copies already on phones were signed with this
  # Mac's debug key: a phone refuses an update signed with a different key.
  local variant=${ANDROID_VARIANT:-release}
  local Variant="$(printf '%s' "${variant:0:1}" | tr '[:lower:]' '[:upper:]')${variant:1}"
  info "== Android: building the $variant APK"
  local abiflag=()
  if [ -n "${ANDROID_ABIS:-}" ]; then abiflag=(-PreactNativeArchitectures="$ANDROID_ABIS"); fi
  (cd "$ANDROID_DIR" && ./gradlew "assemble$Variant" ${abiflag[@]+"${abiflag[@]}"} -q --console=plain)
  local out=$ANDROID_DIR/app/build/outputs/apk/$variant/app-$variant.apk
  if [ ! -f "$out" ]; then
    if [ -f "$ANDROID_DIR/app/build/outputs/apk/$variant/app-$variant-unsigned.apk" ]; then
      echo "The release APK is UNSIGNED, and phones refuse unsigned APKs. Give the release build"
      echo "a signingConfig in $ANDROID_DIR/app/build.gradle (see SKILL.md, 'Signing')."
    else echo "Android build failed: no $out"; fi
    return 1
  fi
  # Copy, then swap in whole: ./ship.sh must never read a half-written APK.
  cp "$out" "$apk.tmp" && mv "$apk.tmp" "$apk"
  info "APK: $apk ($(du -h "$apk" | cut -f1))"
}

build_ios() {
  [ -d ios ] || { echo "No ios/ folder: generate the native project first."; return 1; }
  info "== iPhone: building Release"
  xcodebuild -workspace "$IOS_WORKSPACE" -scheme "$IOS_SCHEME" -configuration Release \
    -destination 'generic/platform=iOS' -derivedDataPath "$iosdd" -allowProvisioningUpdates \
    build 2>&1 | grep -E "error:|BUILD (SUCCEEDED|FAILED)" || true
}

ios_app() { ls -d "$iosdd"/Build/Products/Release-iphoneos/*.app 2>/dev/null | head -1; }

if (( buildstep )); then
  if [ -n "$PREBUILD" ] && (( need_android || need_ios )); then info "== $PREBUILD"; bash -c "$PREBUILD"; fi
  (( need_android )) && build_android
  (( need_ios )) && build_ios
fi
(( need_android )) && { [ -f "$apk" ] || { echo "No APK: run without --install-only"; exit 1; }; }
(( need_ios )) && { [ -n "$(ios_app)" ] || { echo "No iPhone build: run without --install-only"; exit 1; }; }
[ "$mode" = build ] && exit 0

failed=0
for t in "${targets[@]}"; do
  IFS='|' read -r p id label reach <<< "$t"
  info "== $label: installing"
  if [ "$p" = android ]; then
    if adb -s "$id" install -r "$apk"; then
      adb -s "$id" shell monkey -p "$BUNDLE_ID" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
      echo "$label: installed and opened"
    else warn "$label: install failed"; failed=1; fi
  else
    if xcrun devicectl device install app --device "$id" "$(ios_app)"; then
      xcrun devicectl device process launch --device "$id" "$BUNDLE_ID" >/dev/null 2>&1 ||
        echo "Installed. If it won't open: Settings → General → VPN & Device Management → trust the developer."
      echo "$label: installed"
    else warn "$label: install failed (locked, asleep, or off the Wi-Fi?)"; failed=1; fi
  fi
done
exit $failed
