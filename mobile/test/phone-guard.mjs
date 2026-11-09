// Install at test/phone-guard.mjs. The phone-install guard must stop every command that puts
// the app on a phone, and leave builds alone. Add this project's own install commands.
import { classify } from '../../.claude/hooks/phone-install-guard.mjs';

const cases = [
  // must prompt the owner
  ['ask', './phone.sh android --install-only --device pixel'],
  ['ask', './phone.sh --device "iPhone 11 Pro"'],
  ['ask', 'cd ~/proj; ./phone.sh ios --device=CA2E7B8F --install-only 2>&1 | tail -4'],
  ['ask', 'adb -s adb-59120DLCH004BK-8TgXtW._adb-tls-connect._tcp. install -r dist/app.apk'],
  ['ask', 'adb install -r dist/app.apk'],
  ['ask', 'adb install-multiple a.apk b.apk'],
  ['ask', 'xcrun devicectl device install app --device CA2E7B8F ios/build/phone/App.app'],
  ['ask', 'npx expo run:android --device --variant release'],
  ['ask', 'npx expo run:ios --device'],
  ['ask', 'npx cap run android --target abc'],
  ['ask', 'npm run android'],
  ['ask', 'cd android && ./gradlew installRelease'],
  // must be refused outright: a phone install that names no phone
  ['deny', './phone.sh'],
  ['deny', './phone.sh --install-only'],
  ['deny', 'npm run phone'],
  // indirection must not get past it
  ['deny', 'bash -c "./phone.sh --install-only"'],
  ['deny', "sh -c './phone.sh'"],
  ['deny', 'x=./phone.sh; $x'],
  ['deny', '(cd ~/proj && ./phone.sh)'],
  ['ask', 'bash -c "adb install -r dist/app.apk"'],
  ['none', 'grep -n install phone.sh | head -5'],
  ['none', 'bash -n phone.sh && echo ok'],
  // must pass: nothing reaches a phone
  ['none', './phone.sh android --build-only'],
  ['none', './phone.sh --list'],
  ['none', './ship.sh'],
  ['none', './ship.sh --no-build'],
  ['none', 'adb devices -l'],
  ['none', 'adb -s X shell getprop ro.product.model'],
  ['none', 'xcrun devicectl list devices'],
  ['none', 'cd android && ./gradlew assembleRelease'],
  ['none', 'npm test'],
];

let failed = 0;
for (const [want, cmd] of cases) {
  const got = classify(cmd).kind;
  if (got !== want) { failed++; console.log(`FAIL want ${want} got ${got}: ${cmd}`); }
}
console.log(`phone-guard: ${cases.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
