#!/usr/bin/env node
// The laptop end of the phone app. It dials out to the relay (so it works from behind the home
// router), passes the phone's messages into the Assistant and the Assistant's replies back.
//   node mobile/bridge/bridge.mjs            run, using the pairing from pair.mjs

import { randomUUID } from 'node:crypto';
import { Assembler, chunksFor, prepareOutgoing, saveIncoming, withAttachments } from './files.mjs';
import { parseItems, formatAnswers } from './items.mjs';
import { loadPairing, roomURL, findAssistant, deliverToAssistant, TranscriptFollower, status } from './lib.mjs';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function startBridge(pairing, { home, snap, pollMs = 1000, WebSocketImpl = globalThis.WebSocket, wake } = {}) {
  let ws = null;
  let stopped = false;
  let retry = 1000;
  let lastAssistant = null;

  const send = (msg) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ id: randomUUID(), t: Date.now(), ...msg }));
  };

  const assistantState = () => {
    const a = findAssistant(home);
    return !a ? 'closed' : a.state === 'working' ? 'busy' : 'open';
  };
  const stateMsg = () => ({ kind: 'state', laptop: 'online', assistant: assistantState(), assistantName: findAssistant(home)?.name || undefined });

  const follower = new TranscriptFollower(() => findAssistant(home)?.transcript, {
    onReply: ({ text: raw, turn }) => {
      // Cut into items for the phone to walk; the text shown loses the items block.
      const { text, items } = parseItems(raw, turn);
      log('reply', items.length, 'items', text.slice(0, 60));
      send({ kind: 'reply', text, turn, items });
    },
    onPrompt: ({ text, turn }) => send({ kind: 'prompt', text, turn }),
    onPhone: ({ turn }) => send({ kind: 'started', turn }),
    onFiles: ({ files, caption, turn }) => files.forEach((f, i) => sendFile(f, { caption: i === 0 ? caption : undefined, turn: `${turn}-${i}` })),
  });

  // Files the Assistant sent recently. A phone that was in the background (its watcher ignores
  // files) gets them when the app comes back, the same way the relay replays missed replies.
  let outbox = [];
  const KEEP_FILES = 10, KEEP_MS = 24 * 3600_000;
  function sendFile(file, { caption, turn }) {
    let prepared;
    try { prepared = prepareOutgoing(file); } catch (e) {
      log('file', e.message);
      send({ kind: 'reply', text: `(Could not send ${file} to the phone: ${e.message})`, turn: `${turn}-err` });
      return;
    }
    const msgs = chunksFor(prepared.buf, { fid: turn, name: prepared.name, mime: prepared.mime, caption, turn });
    outbox = [...outbox.filter((o) => Date.now() - o.t < KEEP_MS), { t: msgs[0].t, msgs }].slice(-KEEP_FILES);
    log('file to phone', prepared.name, prepared.buf.length);
    for (const m of msgs) send(m);
  }

  // Files from the phone, put back together; a "say" names the ones it carries.
  const incoming = new Assembler();
  const received = new Map();
  follower.poll();

  const tick = setInterval(() => {
    try { follower.poll(); } catch (e) { log('transcript', e.message); }
    const now = assistantState();
    if (now !== lastAssistant) { lastAssistant = now; send(stateMsg()); }
  }, pollMs);

  async function handle(msg) {
    if (msg.kind === 'say') {
      log('phone said', String(msg.text || '').slice(0, 60));
      try {
        const fids = Array.isArray(msg.files) ? msg.files.map(String) : [];
        const missing = fids.filter((f) => !received.has(f));
        if (missing.length) throw new Error('An attachment did not arrive whole. Retry to send it again.');
        // A walk's answers arrive as one batch and go to Tally as one message: one walk, one turn.
        const said = Array.isArray(msg.answers) ? formatAnswers(msg.answers, { left: Number(msg.left) || 0 }) : msg.text;
        const text = withAttachments(said, fids.map((f) => received.get(f)));
        fids.forEach((f) => received.delete(f));
        const { queued } = deliverToAssistant(text, home, { ...(msg.fresh ? { fresh: true } : {}), ...(wake ? { wake } : {}) });
        // Queued: the Assistant was closed, and the app is starting it with this message.
        send({ kind: 'ack', of: msg.id, ...(queued ? { queued: true } : {}) });
        if (queued) { follower.readNextFromStart = true; send({ ...stateMsg(), assistant: 'starting' }); }
      } catch (e) {
        log('say failed', e.message);
        send({ kind: 'error', of: msg.id, text: e.message });
      }
    } else if (msg.kind === 'status') {
      send({ kind: 'status', of: msg.id, projects: await status(home, snap) });
    } else if (msg.kind === 'file') {
      try {
        const whole = incoming.add(msg);
        if (whole) {
          const file = saveIncoming(home, whole);
          received.set(whole.fid, file);
          log('file from phone', file, whole.buf.length);
          send({ kind: 'file-ack', of: whole.fid });
        }
      } catch (e) {
        log('file from phone failed', e.message);
        send({ kind: 'error', of: msg.fid, text: e.message });
      }
    } else if (msg.kind === 'hello') {
      log('phone connected');
      send(stateMsg());
      const since = Number(msg.lastSeen) || 0;
      for (const o of outbox) if (o.t > since) for (const m of o.msgs) send(m);
    }
  }

  function connect() {
    if (stopped) return;
    ws = new WebSocketImpl(roomURL(pairing, 'laptop'));
    ws.onopen = () => { retry = 1000; lastAssistant = null; log('connected to relay'); };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      handle(msg).catch((e) => log('handle', e.message));
    };
    ws.onclose = (ev) => {
      if (stopped) return;
      log(`relay closed (${ev.code}); retrying in ${retry / 1000}s`);
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 60000);
    };
    ws.onerror = () => {};
  }
  connect();

  return { stop() { stopped = true; clearInterval(tick); ws?.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const saved = loadPairing();
  if (!saved) { console.error('Not paired yet. Run: node mobile/bridge/pair.mjs --relay URL'); process.exit(1); }
  // Local testing: the laptop may reach the relay at another address than the phone does
  // (an emulator sees the laptop as 10.0.2.2).
  const pairing = process.env.GENLOCK_RELAY ? { ...saved, relay: process.env.GENLOCK_RELAY } : saved;
  log(`bridge for room ${pairing.room.slice(0, 6)}… via ${pairing.relay}`);
  startBridge(pairing);
}
