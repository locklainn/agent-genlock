// Install at test/phone-select.mjs. phone.sh installs only on phones that were NAMED, in the
// order named, and nowhere else. Runs phone.sh against fake adb / xcrun (PATH is the stub
// folder plus /usr/bin:/bin, and the stubs shadow /usr/bin/xcrun), so no real phone can be
// reached from this test. Every install a stub receives is appended to a log, and each case
// checks the log, not the messages.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'phone-select-'));
const log = join(dir, 'installs.log');
const conf = readFileSync(join(root, 'phone.conf'), 'utf8');
const slug = conf.match(/^APP_SLUG="([^"]+)"/m)[1];

function stub(name, body) {
  writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}
stub('adb', `
case "$*" in
  start-server) exit 0 ;;
  devices) printf 'List of devices attached\\nFAKEPIXEL\\tdevice\\n' ;;
  *"getprop ro.serialno"*) echo SER123 ;;
  *"getprop ro.product.model"*) echo "Pixel 10 Pro" ;;
  *" install "*) echo "android:$2" >> "${log}" ;;
  *) exit 0 ;;
esac`);
// printf -- : a format starting with '-' is otherwise read as an option and prints nothing.
stub('xcrun', `
case "$*" in
  "devicectl list devices")
    printf 'Name     Hostname     Identifier                             State                Model\\n'
    printf -- '-----    ---------    ------------------------------------   ------------------   -----\\n'
    printf 'iPhone   iPhone.local   AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE   %s   iPhone 11 Pro (iPhone12,3)\\n' "\${FAKE_IPHONE_STATE:-available (paired)}" ;;
  *"device install app"*) echo "ios:$6" >> "${log}" ;;
  *) exit 0 ;;
esac`);
stub('sleep', 'exit 0');

// --install-only needs an APK and an iPhone app to exist; make stand-ins if a fresh checkout lacks them.
if (!existsSync(join(root, `dist/${slug}.apk`))) { mkdirSync(join(root, 'dist'), { recursive: true }); writeFileSync(join(root, `dist/${slug}.apk`), 'x'); }
const hasIos = existsSync(join(root, 'ios'));
const products = join(root, 'ios/build/phone/Build/Products/Release-iphoneos');
if (hasIos && !existsSync(products)) mkdirSync(join(products, 'Stand-in.app'), { recursive: true });

function run(args, env = {}) {
  writeFileSync(log, '');
  const r = spawnSync(join(root, 'phone.sh'), args, {
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: process.env.HOME, ...env },
    input: '', encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout + r.stderr, installs: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

const cases = [
  ['no phone named: refuses, installs nothing', ['--install-only'], {}, 2, []],
  ['android + no phone named: refuses', ['android', '--install-only'], {}, 2, []],
  ['names the Pixel: only the Pixel', ['--device', 'pixel', '--install-only'], {}, 0, ['android:FAKEPIXEL']],
  ['iPhone first, then Pixel: that order', ['--device', 'iphone', '--device', 'pixel', '--install-only'], {}, 0, ['ios:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', 'android:FAKEPIXEL']],
  ['"pro" matches both: refuses as ambiguous', ['--device', 'pro', '--install-only'], {}, 2, []],
  ['no match: refuses', ['--device', 'nokia', '--install-only'], {}, 2, []],
  ['named iPhone is locked: installs NOTHING, not even the Pixel', ['--device', 'pixel', '--device', 'iphone', '--install-only'], { FAKE_IPHONE_STATE: 'unavailable' }, 3, []],
  ['--list installs nothing', ['--list'], {}, 0, []],
];

let failed = 0, ran = 0;
for (const [name, args, env, code, installs] of cases) {
  if (!hasIos && installs.some((i) => i.startsWith('ios:'))) { console.log(`skip (no ios/): ${name}`); continue; }
  ran++;
  const r = run(args, env);
  const ok = r.code === code && JSON.stringify(r.installs) === JSON.stringify(installs);
  if (!ok) { failed++; console.log(`FAIL ${name}\n  exit ${r.code} (want ${code}), installs ${JSON.stringify(r.installs)} (want ${JSON.stringify(installs)})\n${r.out}`); }
}
console.log(`phone-select: ${ran - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
