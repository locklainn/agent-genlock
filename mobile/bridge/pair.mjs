#!/usr/bin/env node
// Pair the phone: makes a room on the relay and shows the QR code the phone scans.
//   node mobile/bridge/pair.mjs --relay https://genlock-relay.<you>.workers.dev
//   node mobile/bridge/pair.mjs            show the existing pairing's QR again
//   node mobile/bridge/pair.mjs --revoke   forget the pairing; the phone must scan a new one

import fs from 'node:fs';
import { newPairing, loadPairing, pairingLink, pairingFile, relayKey } from './lib.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function show(p) {
  const link = pairingLink(p);
  try {
    const QR = (await import('qrcode')).default;
    console.log(await QR.toString(link, { type: 'terminal', small: true }));
  } catch {
    console.log('(install the QR printer with: cd mobile/bridge && npm install)');
  }
  console.log('Scan this with the Genlock phone app, or paste this link into it:\n');
  console.log(link, '\n');
}

if (args.includes('--revoke')) {
  const p = loadPairing();
  if (!p) { console.log('Nothing is paired.'); process.exit(0); }
  const url = `${p.relay}/room/${p.room}?role=laptop&revoke=1&key=${relayKey(p.secret)}`;
  try { await fetch(url); } catch (e) { console.log(`The relay could not be told (${e.message}); the pairing is forgotten here anyway.`); }
  fs.rmSync(pairingFile());
  console.log('Unpaired. Run pair.mjs --relay URL to pair again.');
} else if (flag('--relay')) {
  await show(newPairing(flag('--relay')));
  console.log('Now start the bridge: node mobile/bridge/bridge.mjs');
} else {
  const p = loadPairing();
  if (!p) { console.log('Not paired yet. Run: node mobile/bridge/pair.mjs --relay URL'); process.exit(1); }
  await show(p);
}
