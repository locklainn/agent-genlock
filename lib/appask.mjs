/**
 * Asking the Mac app for a session, and knowing whether it heard.
 *
 * genlock asks the app for a session (open, spawn, swap) by dropping a request file in the
 * session's channel folder. The app reads the folder every 0.4 s and answers with a receipt,
 * receipt-ID.json: {ok:true} when it has opened the session (or, for a swap, accepted it for
 * the end of this turn), {ok:false, why, code} when it refused. No receipt in time means nobody
 * is reading the channel (the app quit, crashed, or lost this session), so the request is taken
 * back, which stops a late app opening it as well, and the caller creates the session itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** How long to wait for the app's receipt. GENLOCK_RECEIPT_MS=0 does not wait (tests that play the app). */
export function receiptWait() {
  const raw = process.env.GENLOCK_RECEIPT_MS;
  if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) return Math.max(0, Number(raw));
  return 8000;
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function takeReceipt(file) {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return r;
  } catch { return null; }
}

/**
 * Writes BODY as NAME in CHANNEL and waits for the app's receipt. Returns
 *   { state: 'opened' }                 the app did it (or, for a swap, will at the end of this turn)
 *   { state: 'refused', why, code }     the app said no, and why
 *   { state: 'taken' }                  the app took the file but wrote no receipt (an app from before receipts)
 *   { state: 'lost', waited }           nobody answered: the request was taken back, so nothing opens it later
 *   { state: 'unconfirmed' }            not waited for (GENLOCK_RECEIPT_MS=0)
 * `consumed` says whether the app removes the file when it reads it (open, spawn) or leaves it
 * until it acts (swap); only a removed file can mean "taken".
 */
export function requestOfApp(channel, name, body, { consumed = true } = {}) {
  fs.mkdirSync(channel, { recursive: true });
  const id = randomUUID().slice(0, 8);
  const file = path.join(channel, name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...body, id }));
  fs.renameSync(`${file}.tmp`, file);
  const ms = receiptWait();
  if (ms <= 0) return { state: 'unconfirmed', id };
  const receipt = path.join(channel, `receipt-${id}.json`);
  const verdict = (r) => (r.ok ? { state: 'opened', id } : { state: 'refused', id, why: r.why || 'the app refused it', code: r.code || null });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = takeReceipt(receipt);
    if (r) return verdict(r);
    sleep(100);
  }
  // Nobody answered. Take the request back, so an app that wakes up later cannot open it too.
  let withdrawn = false;
  try { fs.unlinkSync(file); withdrawn = true; } catch { /* the app took it at the last moment */ }
  if (withdrawn) {
    // A receipt written between the last look and the withdrawal still counts: put the request back.
    const late = takeReceipt(receipt);
    if (late) {
      if (late.ok && !consumed) fs.writeFileSync(file, JSON.stringify({ ...body, id }));
      return verdict(late);
    }
    return { state: 'lost', id, waited: ms };
  }
  // Taken just now: the receipt follows within the same tick of the app.
  for (let i = 0; i < 20; i++) {
    const r = takeReceipt(receipt);
    if (r) return verdict(r);
    sleep(100);
  }
  return consumed ? { state: 'taken', id } : { state: 'lost', id, waited: ms };
}

/** Whether a result means the session exists, or will once this turn ends. */
export function appDidIt(res) { return ['opened', 'taken', 'unconfirmed'].includes(res.state); }

/** One line on why the app did not, for the agent. */
export function appFailure(res) {
  if (res.state === 'refused') return `the app refused it: ${res.why}`;
  return `the app did not answer within ${Math.round((res.waited || 0) / 1000)}s (it may have quit, or lost this session), so the request was taken back`;
}
