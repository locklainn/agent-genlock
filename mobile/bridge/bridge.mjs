#!/usr/bin/env node
// The laptop end of the phone app. It dials out to the relay (so it works from behind the home
// router), passes the phone's messages into the Assistant and the Assistant's replies back.
//   node mobile/bridge/bridge.mjs            run, using the pairing from pair.mjs

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Assembler, chunksFor, mimeOf, prepareOutgoing, saveIncoming, withAttachments } from './files.mjs';
import { backupMessages } from './backup.mjs';
import { parseItems, formatAnswers, walkable } from './items.mjs';
import { Voicer, arrivalLine } from './voicing.mjs';
import { speak as genlockSpeak, voiceFor as genlockVoiceFor } from '../../lib/speaker.mjs';
import { loadPairing, roomURL, findAssistant, deliverToAssistant, TranscriptFollower, status, readGrid, sprintReport, genlockHome } from './lib.mjs';
import { startDesk } from './desk.mjs';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function startBridge(pairing, { home, snap, pollMs = 1000, WebSocketImpl = globalThis.WebSocket, wake, speak = genlockSpeak, voiceFor = genlockVoiceFor, desk: withDesk = false, deskPort = 0 } = {}) {
  let ws = null;
  let stopped = false;
  let retry = 1000;
  let lastAssistant = null;
  /** Ids of phone messages handed to the Assistant and not yet seen in its conversation, oldest first. */
  const delivered = [];

  // The desk (the Mac app's Phone window, desk.mjs) gets what the phone gets. Its own messages are
  // answered to it alone, and a reply to one is shown on the phone but not walked there: TJ heard it at the Mac.
  /** Ids of messages the desk sent, so their ack, start and reply are routed to it. */
  const deskIds = new Set();
  let desk = null;
  const send = (msg) => {
    const full = { id: randomUUID(), t: Date.now(), ...msg };
    const fromDesk = deskIds.has(full.of) || deskIds.has(full.reOf);
    const toPhone = full.kind === 'reply' && deskIds.has(full.reOf) ? { ...full, walk: false, origin: 'desk' }
      : fromDesk && (full.kind === 'ack' || full.kind === 'started' || full.kind === 'error') ? null : full;
    if (toPhone && ws?.readyState === 1) ws.send(JSON.stringify(toPhone));
    if (desk && full.kind !== 'clip' && full.kind !== 'file' && full.kind !== 'backup-file') desk.send(fromDesk && full.kind === 'reply' ? { ...full, origin: 'desk' } : full);
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

  /** Which phone message began each transcript turn (prompt uuid -> the phone's message id). */
  const phoneTurns = new Map();
  const follower = new TranscriptFollower(() => findAssistant(home)?.transcript, {
    onReply: ({ text: raw, turn, answers, prompt }) => {
      // Cut into items for the phone to walk; the text shown loses the items block.
      const { text, items: cut, quiet, block } = parseItems(raw, turn);
      // A review's images go to the phone as files, and the item names each by its file id.
      const items = cut.map((it) => (it.images ? { ...it, images: it.images.map((im, k) => {
        const fid = `${it.id}-img${k}`;
        sendFile(im.path, { turn: fid });
        // path: the Mac's Focus Mode opens the image where it is; the phone uses the file it was sent.
        return { fid, name: path.basename(im.path), path: im.path, ...(im.caption ? { caption: im.caption } : {}) };
      }) } : it)).map((it) => (it.files ? { ...it, files: it.files.map((f, k) => {
        // Documents ride the same transport; the phone lists each as a link to open or save.
        const fid = `${it.id}-file${k}`;
        sendFile(f.path, { turn: fid });
        return { fid, name: path.basename(f.path), path: f.path, mime: mimeOf(f.path), ...(f.caption ? { caption: f.caption } : {}) };
      }) } : it)).map(withVoice);
      // A reply to TJ at the laptop or Remote Control was read there: the phone shows it, not walks it.
      // Nor one whose items block is empty: nothing in it is new to him (a repeat of what Tally said).
      // Any reply with an items block walks, whatever began the turn: TJ gets news without asking from the phone.
      const walk = walkable({ answers, quiet, items, block });
      log('reply', items.length, 'items', walk ? '' : quiet ? '(not walked: nothing new)' : '(not walked)', text.slice(0, 60));
      // What this reply answers, for the phone's YOU SAID: TJ's own words, or '' when an event began
      // the turn (a relay report, an alert). reOf names the phone's own message, so it quotes that.
      const reOf = prompt?.source === 'phone' ? phoneTurns.get(prompt.turn) : undefined;
      send({ kind: 'reply', text, turn, items, re: prompt?.text?.slice(0, 400) || '', ...(reOf ? { reOf } : {}), ...(walk ? {} : { walk: false }) });
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
    onPhone: ({ turn }) => {
      const of = delivered.shift();
      if (of) { phoneTurns.set(turn, of); if (phoneTurns.size > 50) phoneTurns.delete(phoneTurns.keys().next().value); }
      send({ kind: 'started', turn, ...(of ? { of } : {}) });
    },
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

  // The desk's hello: the same catch-up the phone gets, without touching the phone's voice setting.
  function deskHello() {
    desk.send(stateMsg());
    const { msg } = gridMsg();
    desk.send(msg);
    try { follower.poll(); } catch {}
    if (follower.mark) desk.send({ kind: 'moved', at: follower.mark });
  }
  if (withDesk) {
    desk = startDesk({
      home: home || genlockHome(), port: deskPort, log,
      onMessage: async (msg) => {
        if (msg.kind === 'hello') return deskHello();
        if (msg.kind === 'clips' || msg.kind === 'diag' || msg.kind === 'backup' || msg.kind === 'file') return;
        if (msg.kind === 'say') {
          deskIds.add(msg.id);
          if (deskIds.size > 200) deskIds.delete(deskIds.values().next().value);
          // TJ took his news at the Mac: what the phone still holds from before now is past.
          if (ws?.readyState === 1) ws.send(JSON.stringify({ id: randomUUID(), t: Date.now(), kind: 'moved', at: Date.now() }));
        }
        await handle(msg);
      },
    });
    desk.ready.catch((e) => log('desk failed', e.message));
  }

  return { desk, stop() { stopped = true; clearInterval(tick); ws?.close(); desk?.stop(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const saved = loadPairing();
  if (!saved) { console.error('Not paired yet. Run: node mobile/bridge/pair.mjs --relay URL'); process.exit(1); }
  // Local testing: the laptop may reach the relay at another address than the phone does
  // (an emulator sees the laptop as 10.0.2.2).
  const pairing = process.env.GENLOCK_RELAY ? { ...saved, relay: process.env.GENLOCK_RELAY } : saved;
  log(`bridge for room ${pairing.room.slice(0, 6)}… via ${pairing.relay}`);
  startBridge(pairing, { desk: true });
}
