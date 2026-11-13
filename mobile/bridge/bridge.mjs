#!/usr/bin/env node
// The laptop end of the phone app. It dials out to the relay (so it works from behind the home
// router), passes the phone's messages into the Assistant and the Assistant's replies back.
//   node mobile/bridge/bridge.mjs            run, using the pairing from pair.mjs

import { randomUUID } from 'node:crypto';
import { Assembler, chunksFor, prepareOutgoing, saveIncoming, withAttachments } from './files.mjs';
import { backupMessages } from './backup.mjs';
import { parseItems, formatAnswers } from './items.mjs';
import { Voicer, arrivalLine } from './voicing.mjs';
import { speak as genlockSpeak, voiceFor as genlockVoiceFor } from '../../lib/speaker.mjs';
import { loadPairing, roomURL, findAssistant, deliverToAssistant, TranscriptFollower, status, readGrid, sprintReport } from './lib.mjs';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function startBridge(pairing, { home, snap, pollMs = 1000, WebSocketImpl = globalThis.WebSocket, wake, speak = genlockSpeak, voiceFor = genlockVoiceFor } = {}) {
  let ws = null;
  let stopped = false;
  let retry = 1000;
  let lastAssistant = null;
  /** Ids of phone messages handed to the Assistant and not yet seen in its conversation, oldest first. */
  const delivered = [];

  const send = (msg) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ id: randomUUID(), t: Date.now(), ...msg }));
  };

  const assistantState = () => {
    const a = findAssistant(home);
    return !a ? 'closed' : a.state === 'working' ? 'busy' : 'open';
  };
  const stateMsg = () => ({ kind: 'state', laptop: 'online', assistant: assistantState(), assistantName: findAssistant(home)?.name || undefined });

  // Replies in the Genlock voice: clips made by the Mac's speaker. speak: null leaves the phone's own voice.
  const voicer = speak ? new Voicer({ speak, send: (m) => send(m), log }) : null;
  // The phone said in its hello that it makes the voice itself (its model is installed): then no
  // clips are made or sent, and no speech crosses the network (TJ, 2026-11-12).
  let ondevice = false;
  /** Each item carries its project's voice, so the phone reads it in the voice the Mac would. */
  const withVoice = (it) => {
    try { const v = voiceFor({ project: it.project }); return v ? { ...it, voice: { parts: v.parts, speed: v.speed || 1 } } : it; } catch (e) { log('voice for', it.project, e.message); return it; }
  };

  const follower = new TranscriptFollower(() => findAssistant(home)?.transcript, {
    onReply: ({ text: raw, turn, answers }) => {
      // Cut into items for the phone to walk; the text shown loses the items block.
      const { text, items: cut } = parseItems(raw, turn);
      const items = cut.map(withVoice);
      // A reply to TJ at the laptop or Remote Control was read there: the phone shows it, not walks it.
      const walk = answers !== 'laptop';
      log('reply', items.length, 'items', walk ? '' : '(not walked)', text.slice(0, 60));
      send({ kind: 'reply', text, turn, items, ...(walk ? {} : { walk: false }) });
      if (walk && !ondevice && voicer) {
        // The arrival screen's line first: it is said before any item. The phone asks by the same
        // id (arrive:<line>), so when nothing else was pending its clip is already here.
        const line = arrivalLine(items);
        voicer.line(`arrive:${line}`, line).catch((e) => log('voice', e.message));
        voicer.reply(items).catch((e) => log('voice', e.message));
      }
    },
    onPrompt: ({ text, turn }) => send({ kind: 'prompt', text, turn }),
    // TJ moved on away from the phone: what it holds from before now is past.
    onMoved: ({ at }) => send({ kind: 'moved', at }),
    // Phone messages reach the conversation in the order they were delivered: this one is the oldest still waiting.
    onPhone: ({ turn }) => { const of = delivered.shift(); send({ kind: 'started', turn, ...(of ? { of } : {}) }); },
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

  // The Mac grid view, pushed each time the app rewrites it, so the phone's Status tab stays live.
  let lastGrid = null;
  const gridMsg = () => { const { sig, ...g } = readGrid(home); return { msg: { kind: 'grid', ...g }, sig }; };
  const pushGrid = (force) => {
    const { msg, sig } = gridMsg();
    if (!force && sig === lastGrid) return;
    lastGrid = sig;
    send(msg);
  };

  const tick = setInterval(() => {
    try { follower.poll(); } catch (e) { log('transcript', e.message); }
    try { pushGrid(false); } catch (e) { log('grid', e.message); }
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
        delivered.push(msg.id);
        if (delivered.length > 50) delivered.shift();
        send({ kind: 'ack', of: msg.id, ...(queued ? { queued: true } : {}) });
        if (queued) { follower.readNextFromStart = true; send({ ...stateMsg(), assistant: 'starting' }); }
      } catch (e) {
        log('say failed', e.message);
        send({ kind: 'error', of: msg.id, text: e.message });
      }
    } else if (msg.kind === 'clips') {
      // A line that is no item (arrive:...) comes with its text: voice it if it is not made already.
      if (voicer && msg.text && !voicer.items.has(String(msg.item))) await voicer.line(String(msg.item || ''), String(msg.text).slice(0, 300));
      else if (voicer) await voicer.again(String(msg.item || ''));
      else send({ kind: 'clip', item: String(msg.item || ''), failed: true });
    } else if (msg.kind === 'diag') {
      // What the phone saw while speaking (which speaker a clip played on, why it waited): for debugging sound.
      log('phone:', String(msg.text || '').slice(0, 300));
    } else if (msg.kind === 'status') {
      pushGrid(true);
      send({ kind: 'status', of: msg.id, projects: await status(home, snap) });
    } else if (msg.kind === 'backup') {
      // The phone's Back up button: every project's records as one archive, saved on the phone.
      try {
        const msgs = await backupMessages(msg.id, home);
        log('backup to phone', msgs[0]?.name, msgs[0]?.size);
        for (const m of msgs) send(m);
      } catch (e) {
        log('backup failed', e.message);
        send({ kind: 'error', of: msg.id, text: `Backup failed: ${e.message}` });
      }
    } else if (msg.kind === 'sprint') {
      // The sprint report: { sprint } or { from, to }. The same document the Mac app reads.
      try {
        send({ kind: 'sprint', of: msg.id, report: await sprintReport(home, { sprint: msg.sprint, from: msg.from, to: msg.to }) });
      } catch (e) {
        log('sprint failed', e.message);
        send({ kind: 'error', of: msg.id, text: e.message });
      }
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
      ondevice = Boolean(msg.ondevice);
      log('phone connected', msg.version ? `(build ${msg.version})` : '(build unknown: older than 0.1.454734)', ondevice ? 'voice on the phone' : 'voice from the Mac');
      send(stateMsg());
      pushGrid(true);
      // The latest moved-on mark, every time: a phone that was away learns what it holds is past.
      try { follower.poll(); } catch {}
      if (follower.mark) send({ kind: 'moved', at: follower.mark });
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
