// The desk: the Mac app's Phone window, a second client of the bridge that sits on the same laptop.
// It gets every message the phone gets and sends what the phone sends, so the Mac window is the
// phone app's thread and walk-through without a second backend. It listens on 127.0.0.1 only, with a
// token written (mode 600) to Application Support/Genlock/phone/desk.json for the Mac app to read.
//
//   GET  /events?token=T&lastSeen=MS   server-sent events: one JSON message per `data:` line
//   POST /send   (Authorization: Bearer T)   one JSON message, handled as if the phone sent it

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export const deskFile = (home) => path.join(home, 'phone', 'desk.json');

/** Kinds a desk that was away is sent again on hello, newest 80. */
const KEPT = new Set(['reply', 'ack', 'prompt', 'started', 'error']);
const KEEP = 80;

/**
 * Starts the desk listener. onMessage(msg) gets each message the desk sends. Returns
 * { send(msg), replay(since), port, ready, stop() }; send reaches every connected desk.
 */
export function startDesk({ home, onMessage, port = 0, log = () => {} } = {}) {
  const token = randomBytes(24).toString('hex');
  const clients = new Set();
  const kept = [];

  const write = (res, msg) => { try { res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch {} };
  const send = (msg) => {
    const full = { id: randomUUID(), t: Date.now(), ...msg };
    if (KEPT.has(full.kind)) { kept.push(full); if (kept.length > KEEP) kept.shift(); }
    for (const res of clients) write(res, full);
    return full;
  };

  const authed = (req, url) => (url.searchParams.get('token') || req.headers.authorization?.replace(/^Bearer /, '')) === token;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!authed(req, url)) { res.writeHead(401).end('unpaired\n'); return; }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': desk\n\n');
      clients.add(res);
      log('desk connected', clients.size);
      // What it missed while it was closed: the reply it was waiting on is not lost.
      const since = Number(url.searchParams.get('lastSeen')) || 0;
      for (const m of kept) if (m.t > since) write(res, m);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); log('desk left', clients.size); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
      req.on('end', () => {
        let msg;
        try { msg = JSON.parse(body); } catch { res.writeHead(400).end('bad json\n'); return; }
        if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') { res.writeHead(400).end('no kind\n'); return; }
        msg.id = String(msg.id || randomUUID());
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, id: msg.id }));
        Promise.resolve().then(() => onMessage?.(msg)).catch((e) => log('desk handle', e.message));
      });
      return;
    }
    res.writeHead(404).end('not found\n');
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      const file = deskFile(home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ port: p, token, pid: process.pid }), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      api.port = p;
      log(`desk on 127.0.0.1:${p}`);
      resolve(p);
    });
  });

  const api = {
    port: 0, token, ready, send,
    get connected() { return clients.size; },
    stop() {
      for (const res of clients) { try { res.end(); } catch {} }
      clients.clear();
      server.close();
      try { const f = deskFile(home); if (JSON.parse(fs.readFileSync(f, 'utf8')).token === token) fs.rmSync(f); } catch {}
    },
  };
  return api;
}
