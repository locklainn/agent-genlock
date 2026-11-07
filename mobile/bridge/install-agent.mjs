#!/usr/bin/env node
// Keep the phone bridge running: installs a macOS launch agent that starts it at login and
// restarts it if it stops.
//   node mobile/bridge/install-agent.mjs             install (or reinstall) and start it
//   node mobile/bridge/install-agent.mjs --remove    stop it and remove it
//   node mobile/bridge/install-agent.mjs --status    is it running?

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPairing } from './lib.mjs';

const LABEL = 'com.genlock.phone-bridge';
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logDir = path.join(os.homedir(), 'Library', 'Logs', 'Genlock');
const log = path.join(logDir, 'phone-bridge.log');
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge.mjs');
const domain = `gui/${process.getuid()}`;

const launchctl = (...args) => {
  try { return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return e.stdout || ''; }
};
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const arg = process.argv[2];

if (arg === '--status') {
  const out = launchctl('print', `${domain}/${LABEL}`);
  const state = out.match(/state = (\w+)/)?.[1];
  const pid = out.match(/pid = (\d+)/)?.[1];
  console.log(state ? `phone bridge: ${state}${pid ? ` (pid ${pid})` : ''}\nlog: ${log}` : 'phone bridge: not installed');
} else if (arg === '--remove') {
  launchctl('bootout', `${domain}/${LABEL}`);
  fs.rmSync(plist, { force: true });
  console.log('Removed. The phone will show the laptop as offline.');
} else {
  if (!loadPairing()) { console.error('Pair first: node mobile/bridge/pair.mjs --relay URL'); process.exit(1); }
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(script)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`);
  launchctl('bootout', `${domain}/${LABEL}`);
  launchctl('bootstrap', domain, plist);
  console.log(`Installed. The bridge starts at login and restarts if it stops.\nlog: ${log}`);
}
