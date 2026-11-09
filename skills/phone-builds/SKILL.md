---
name: phone-builds
description: Push an app's release builds to phones, over Wi-Fi straight to a named phone (Android and iPhone) and by a Cloudflare R2 download link (Android), with a hard lock so no agent can install on a phone the owner did not name and approve. Use when asked to deploy, install or push a build to a phone, to share a build by link, or to set this up in a project that does not have it yet.
---

# Builds to phones: over Wi-Fi, and by link

A genlock module, opt-in because most projects have no phone app:
`genlock install --only phone --skill` adds the rule to the project's agent file and this
skill, with its `templates/`, to `.claude/skills/`. Then follow "Adopting it" below.

Built and proved in Wildcard (`~/calendar/ActivityApp`, commit `c3ba32c`, 2026-11-09),
an Expo 57 / React Native app. The scripts are in `templates/`. Nothing here has been run
in a Capacitor/Ionic project yet; the Capacitor notes below come from how Capacitor is
documented, not from a test run.

## What it gives a project

| | Wi-Fi install | Download link |
|---|---|---|
| Command | `./phone.sh --device NAME` | `./ship.sh` |
| Android | yes: adb over wireless debugging | yes: R2 page + APK, same link every build |
| iPhone | yes: `xcrun devicectl`, phone **unlocked** | **no**: Apple allows that only through TestFlight/ad-hoc (paid $99/yr account) |
| Reaches | phones paired with this Mac, on the same Wi-Fi | anyone with the link, anywhere |
| Needs Metro / the Mac afterwards | no: always a **release** build, the JS is bundled in | no |

## The rule this exists to enforce, and why it is a lock and not an instruction

The owner, TJ (2026-11-09): *"make sure we CANNOT put this on a phone remotely unless
specifically approved, even if we have the connection to it ... i dont want that to be an
agentic skill. it has to be a hard requirement."*

This file is a skill, so it is **policy**: an agent can ignore it. The requirement
therefore lives in two **mechanisms** that this skill installs, and either one alone stops
an unapproved install:

1. **`phone.sh` has no every-phone mode.** It installs only on phones named with
   `--device`, in the order named. If you name nothing, it refuses (a person at a terminal
   gets a menu instead). If a name matches no phone or two phones, or a named phone is
   locked, **nothing is installed anywhere**, not even on the other named phones.
2. **A PreToolUse hook** (`.claude/hooks/phone-install-guard.mjs`) reads every Bash
   command before it runs:
   - a phone install that names no phone is **denied**;
   - every other phone install (`adb install`, `devicectl device install`, `expo run --device`,
     `gradlew install*`, `cap run`, `phone.sh --device`) becomes a **permission prompt**
     that only the person at the keyboard can answer;
   - it is registered with `onFailure: "block"`, so a crash in the guard blocks the command
     rather than letting it through (it **fails closed**).

**Agent rules on top of the locks:**
- When asked to deploy to phones, run `./phone.sh --list`, then **ask which phone(s)**
  (AskUserQuestion), then `./phone.sh --device NAME [--device NAME2]` in the order they
  gave. Never pick for them, and never install on everything in reach.
- **Never route around either lock**: no script files that call adb/devicectl, no renamed
  copies of phone.sh, no `adb install` hidden in another tool. A block means stop and ask.
- The guard counts **any mention** of `phone.sh` as running it, unless every part of the
  command is a read-only tool (grep, cat, git, ...). So a commit message or a `cp` naming
  phone.sh gets blocked too. That is a deliberate **false positive**: rephrase the harmless
  command (e.g. `git commit -F msgfile`), don't weaken the guard.

**Known gaps (say these out loud, don't hide them):**
- A script file that installs without the command naming it (`bash /tmp/x.sh` containing
  `adb install`) is not caught. The agent rule above covers it; no mechanism does.
- The hook only covers Claude Code in a project that has it. The owner's own terminal is
  deliberately uncovered, and so is any project that hasn't adopted this.

## Adopting it in a project (do it in THIS order)

The guard blocks commands that name `phone.sh`, so put the scripts in place **before** the
hook exists.

1. **Read the project first.** Which native folders exist (`android/`, `ios/`)? Expo/RN,
   Capacitor, or something else? Is there already a phone/build script? Does the project
   have a wrangler install (`npx --no-install wrangler --version`) and a Cloudflare account?
2. **Copy the files** from `~/.claude/skills/phone-builds/templates/`:
   - `phone.conf` → `./phone.conf`, then **fill in every value** (it ships with Wildcard's).
   - `phone.sh` → `./phone.sh`; `ship.sh` → `./ship.sh`; `chmod +x phone.sh ship.sh`.
   - `phone-select.test.mjs` → `test/phone-select.mjs`.
   - `phone-guard.test.mjs` → `test/phone-guard.mjs`.
3. **Add `dist/` to `.gitignore`**, and `ios/build/` if it isn't there.
4. **Install the hook last:** `phone-install-guard.mjs` → `.claude/hooks/phone-install-guard.mjs`,
   then MERGE this into the `hooks.PreToolUse` array of the project's `.claude/settings.json`
   (read the file first, keep every existing hook):
   ```json
   { "matcher": "Bash",
     "hooks": [{ "type": "command",
                 "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/phone-install-guard.mjs\"",
                 "onFailure": "block", "timeout": 10 }] }
   ```
   If the project has its own scripts that install on a device (Wildcard had `build.sh ios`),
   add them to `installs` in the guard and add a case to `test/phone-guard.mjs`.
5. **Wire the tests in**: `"test:phone": "node test/phone-guard.mjs && node test/phone-select.mjs"`
   and append it to the main `test` script. Optionally `"phone": "./phone.sh"`, `"ship": "./ship.sh"`.
6. **Prove each part** and report what you saw, not that you did it:
   - `npm run test:phone`: both suites pass (31 guard cases, 8 phone-picking cases; the
     iPhone case is skipped if there's no `ios/`);
   - **the hook is live**: run `./phone.sh` with no `--device` from Claude Code. It must come
     back **Blocked**. If it runs instead, the settings watcher didn't pick up the new hook:
     the owner opens `/hooks` once or restarts the session;
   - `./phone.sh --list` shows the paired phones;
   - `./phone.sh android --build-only` produces `dist/<slug>.apk`;
   - `./ship.sh` prints `Shipped: URL (N bytes, checked online)`;
   - one real install, **only on a phone the owner names, after they approve the prompt**.
7. Record it in the project's shipped/changelog file, including what wasn't exercised.

### Expo / React Native
- `PREBUILD=""`: the Gradle and Xcode release builds bundle the JS themselves (Hermes
  bytecode on Android).
- `ANDROID_ABIS="arm64-v8a,armeabi-v7a"`: real phones are ARM. Dropping the x86 emulator
  ABIs **halved** Wildcard's APK, which matters for a download.
- Expo 57 needs Node ≥ 20.19.4 in the shell that builds. Older versions misread commented
  `.env` lines.
- If `android/` or `ios/` don't exist yet: `npx expo prebuild` (check the project doesn't
  have its own build script that does this first).

### Native Android (Kotlin / Java, no JS layer)
Proved in genlock's own phone app (`mobile/`, 2026-11-09).
- `PREBUILD=""`, `ANDROID_ABIS=""`; no `ios/`, so leave the iOS values empty.
- **`ANDROID_VARIANT`**: if the copies already on phones came from `assembleDebug` (signed
  with this Mac's own `~/.android/debug.keystore`), set `ANDROID_VARIANT="debug"`. A release
  build signed with any other key would be refused as an update. Moving to release is the
  signing decision below, and it is the owner's.
- `JDK_HOME`: point it at a JDK 17 when the shell's `JAVA_HOME` is older (Gradle 8 needs 17).
- The scripts can live beside the app rather than at the repo root (genlock: `mobile/`);
  put the two tests in a folder below them and fix the guard import path in
  `phone-guard.test.mjs` to reach `.claude/hooks/` from there.

### Capacitor / Ionic (untested here, check against the project's real setup)
- `PREBUILD="npm run build && npx cap sync"`; `ANDROID_ABIS=""`;
  `IOS_WORKSPACE="ios/App/App.xcworkspace"`, `IOS_SCHEME="App"`.
- **Signing:** Capacitor's `assembleRelease` usually produces `app-release-unsigned.apk`,
  and phones refuse unsigned APKs. `phone.sh` detects this and stops. Add a release
  `signingConfig` to `android/app/build.gradle` (see Signing below) before going further.

## One-time setup per phone

- **Android:** Settings → About → tap Build number 7× → Developer options → **Wireless
  debugging** on → "Pair device with pairing code" → on the Mac, `adb pair IP:PORT CODE`.
  After that, adb finds the phone by itself (mDNS) whenever both are on the same Wi-Fi.
  A USB cable with USB debugging works too.
- **iPhone:** plug in once, tap **Trust**, turn **Developer Mode** on (Settings → Privacy &
  Security), and open the Xcode project once so a signing team is set. After that, devicectl
  reaches it over Wi-Fi **while it is unlocked**. A locked or sleeping iPhone shows as
  `unavailable` in `xcrun devicectl list devices` and every install fails (CoreDevice error
  1011). Ask the owner to unlock it rather than retrying.
- **Free Apple team** (no paid account): at most 3 devices, and each install **expires
  after 7 days**. The fix is a reinstall, which keeps the data.

## One-time: the R2 bucket (download link)

1. `npx wrangler r2 bucket create <app>-builds`
2. Turn on the public r2.dev address: Cloudflare dashboard → R2 → the bucket → Settings →
   Public access → **r2.dev subdomain → Allow** (or
   `npx wrangler r2 bucket dev-url enable <app>-builds`). Put the `https://pub-….r2.dev`
   address in `R2_PUBLIC`.
3. The first `./ship.sh` creates `SHIP_TOKEN_FILE`, a random secret that becomes part of
   the address. It lives in the home folder and **never in the repo**. r2.dev serves no
   directory listing, so the link can't be found without being given. Delete the file and
   ship again to retire every link handed out so far.
4. The link is the same for every build: people bookmark it once.

## Signing: the decision to raise with the owner, not make

An Android phone accepts an update only if it's signed with **the same key** as the copy
already installed. Expo/RN release builds are signed with the stock **debug keystore** by
default. That key is public (it's in every RN template), so anyone could sign an APK that
installs over yours.
- That's acceptable for builds that only go out over Wi-Fi to the owner's phones.
- For a public link it's a hole. A private key closes it, but **switching keys forces
  every existing install to uninstall once, losing that phone's local data**.
- So: ask the owner, record the answer, and never switch silently. (Wildcard: still open.)

## Lessons that cost time in Wildcard (2026-11-08/09)

- **awk `/available/` matches "unavailable"**: a locked iPhone was treated as in reach.
  Test the negative first.
- **`printf '-----'` prints nothing**: a format starting with `-` is read as an option.
  Use `printf --`.
- **`set -euo pipefail` + a loop whose last line is `[[ … ]] && echo`** exits the script
  when the test is false. Use `if …; then …; fi`.
- **Upload a snapshot, never `dist/` itself**: a build started in another terminal rewrote
  the APK mid-upload and put a broken file online (nightmaremode). `ship.sh` copies the
  APK first, checks it with `unzip -tq`, and swaps builds in with `cp` to a tmp file then
  `mv`.
- **Prove the upload from outside**: compare the online `content-length` with the local
  byte count, and check the live page shows this build's timestamp. The wrangler exit code
  alone isn't proof.
- **Upload the APK first, then the page**, so the page never links to a missing file.
- **The guard's first draft missed `npm run phone:ios` and `bash -c "./phone.sh"`**, and
  blocked `grep phone.sh`. The read-only-segments approach plus the indirection cases in
  `test/phone-guard.mjs` came out of that. Keep those cases.
- **Test with fake phones, not real ones**: `test/phone-select.mjs` puts stub `adb`/`xcrun`
  first on PATH and checks the log of installs they received, so a refusal path can't
  quietly install on a real phone.
