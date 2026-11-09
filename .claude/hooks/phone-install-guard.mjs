#!/usr/bin/env node
// PreToolUse guard: nothing gets installed on a phone without the owner approving it, by name.
// Install at .claude/hooks/phone-install-guard.mjs (see SKILL.md for the settings.json entry).
//
// TJ, 2026-11-09: "make sure we CANNOT put this on a phone remotely unless specifically
// approved, even if we have the connection to it ... it has to be a hard requirement."
//
// So this is not an instruction an agent can choose to follow. Every Bash command is read
// here before it runs. One that would install the app on a phone (adb install, devicectl
// install, phone.sh, expo run --device, gradle install, cap run) is either:
//   - DENIED, when it does not name the phone (phone.sh without --device), or
//   - turned into a permission PROMPT that only the person at the keyboard can answer.
//
// Builds that install nothing (phone.sh --build-only / --list, ship.sh, simulators and
// emulators) pass through untouched. Tested by test/phone-guard.mjs.
// If this project has its own scripts that install on a device, ADD THEM to `installs`
// below and add a case to test/phone-guard.mjs.

export function classify(cmd) {
  const c = ` ${cmd} `;
  // Any mention of phone.sh counts as running it (so `bash -c "./phone.sh"`, `x=phone.sh; $x`
  // and friends are caught) unless EVERY segment of the command is a read-only tool, so that
  // `grep install phone.sh | head` still works. Erring this way costs a blocked grep; erring
  // the other way costs an install nobody approved.
  const readOnly = /^\s*(grep|rg|cat|head|tail|less|wc|ls|stat|file|diff|git|shellcheck|bash\s+-n|node\s+test\/|echo\s+[^$`]*$|cd\s)/;
  const segments = cmd.split(/&&|\|\||[;|&\n]/).filter((s) => s.trim());
  const mentionsPhoneSh = /phone\.sh\b/.test(cmd) && !segments.every((s) => readOnly.test(s));
  if (mentionsPhoneSh || /\bnpm\s+run\s+phone(?![:\w])/.test(c)) {
    if (/--build-only\b|--list\b/.test(c)) return { kind: 'none' };
    if (!/--device[\s=]\S/.test(c))
      return { kind: 'deny', why: 'phone.sh installs only on a phone named with --device NAME. Ask which phone (./phone.sh --list shows them), then pass that one.' };
    return { kind: 'ask' };
  }
  const installs = [
    /\badb\b[^;&|]*\binstall(-multiple|-multi-package)?\b/,      // adb [-s X] install
    /\bdevicectl\b[^;&|]*\bdevice\s+install\b/,                   // xcrun devicectl device install app
    /\bios-deploy\b/,
    /\bexpo\s+run:(android|ios)\b[^;&|]*--device\b/,              // expo run onto a device
    /\bnpm\s+run\s+(android|ios)\b/,
    /\bgradlew\b[^;&|]*\binstall[A-Z]\w*/,                        // ./gradlew installRelease
    /\bcap\s+run\s+(android|ios)\b/,                              // Capacitor: npx cap run
    /\bbuild(-release|-dev)?\.sh\s+(ios|android)(?!\s+(sim|emu)\b)/, // build.sh ios|android device targets
  ];
  if (installs.some((re) => re.test(c))) return { kind: 'ask' };
  return { kind: 'none' };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let cmd = '';
  try { cmd = JSON.parse(raw)?.tool_input?.command ?? ''; } catch { return; }
  const v = classify(cmd);
  if (v.kind === 'none') return;
  const reason = v.kind === 'deny'
    ? `Blocked: ${v.why}`
    : `PHONE INSTALL — this puts the app on a phone. Approve only if you asked for this exact phone just now:\n  ${cmd}`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: v.kind, permissionDecisionReason: reason },
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
