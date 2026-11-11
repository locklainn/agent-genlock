#!/usr/bin/env node
// The laptop end of the phone app. It dials out to the relay (so it works from behind the home
// router), passes the phone's messages into the Assistant and the Assistant's replies back.
//   node mobile/bridge/bridge.mjs            run, using the pairing from pair.mjs

import { randomUUID } from 'node:crypto';
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
    onReply: ({ text, turn }) => { log('reply', text.slice(0, 60)); send({ kind: 'reply', text, turn }); },
    onPrompt: ({ text, turn }) => send({ kind: 'prompt', text, turn }),
    onPhone: ({ turn }) => send({ kind: 'started', turn }),
  });
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
        const { queued } = deliverToAssistant(String(msg.text || ''), home, { ...(msg.fresh ? { fresh: true } : {}), ...(wake ? { wake } : {}) });
        // Queued: the Assistant was closed, and the app is starting it with this message.
        send({ kind: 'ack', of: msg.id, ...(queued ? { queued: true } : {}) });
        if (queued) { follower.readNextFromStart = true; send({ ...stateMsg(), assistant: 'starting' }); }
      } catch (e) {
        send({ kind: 'error', of: msg.id, text: e.message });
      }
    } else if (msg.kind === 'status') {
      send({ kind: 'status', of: msg.id, projects: await status(home, snap) });
    } else if (msg.kind === 'hello') {
      log('phone connected');
      send(stateMsg());
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
