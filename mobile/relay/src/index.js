// Genlock phone relay: the meeting point the laptop's bridge and the phone both dial out to.
// One Durable Object per pairing ("room"). It checks each side's key, passes messages between
// them, and keeps the last few laptop -> phone messages so a phone that was away catches up.

const KEEP = 50;
const ROLES = new Set(['laptop', 'phone']);

const sha256 = async (text) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('genlock relay\n');
    const m = url.pathname.match(/^\/room\/([a-f0-9]{32})$/);
    if (!m) return new Response('not found\n', { status: 404 });
    const id = env.ROOMS.idFromName(m[1]);
    return env.ROOMS.get(id).fetch(request);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const key = url.searchParams.get('key') || request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!ROLES.has(role) || !key) return new Response('unpaired\n', { status: 401 });

    // The laptop registers the room the first time it connects; after that the key must match.
    const want = await this.state.storage.get('keyHash');
    const got = await sha256(key);
    if (!want) {
      if (role !== 'laptop') return new Response('unpaired\n', { status: 401 });
      await this.state.storage.put('keyHash', got);
    } else if (want !== got) {
      return new Response('unpaired\n', { status: 401 });
    }

    if (url.searchParams.get('revoke') === '1' && role === 'laptop') {
      for (const ws of this.state.getWebSockets()) ws.close(4001, 'revoked');
      await this.state.storage.deleteAll();
      return new Response('revoked\n');
    }

    if (request.headers.get('upgrade') !== 'websocket') return new Response('expected websocket\n', { status: 426 });

    // One connection per role: a new one replaces the old.
    for (const ws of this.state.getWebSockets(role)) ws.close(4000, 'replaced');
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server, [role]);
    if (role === 'laptop') this.tell('phone', { kind: 'state', laptop: 'online' });
    else server.send(JSON.stringify({ kind: 'state', laptop: this.state.getWebSockets('laptop').length ? 'online' : 'offline' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  tell(role, msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets(role)) { try { ws.send(text); } catch {} }
  }

  async webSocketMessage(ws, data) {
    const [role] = this.state.getTags(ws);
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (role === 'phone') {
      if (msg.kind === 'hello') {
        const kept = (await this.state.storage.get('kept')) || [];
        for (const k of kept) if ((k.t || 0) > (msg.lastSeen || 0)) ws.send(JSON.stringify(k));
      }
      if (!this.state.getWebSockets('laptop').length && msg.kind !== 'hello') {
        ws.send(JSON.stringify({ kind: 'error', of: msg.id, text: 'The laptop is offline.' }));
        return;
      }
      this.tell('laptop', msg);
    } else {
      if (msg.kind === 'reply' || msg.kind === 'ack') {
        const kept = (await this.state.storage.get('kept')) || [];
        kept.push(msg);
        await this.state.storage.put('kept', kept.slice(-KEEP));
      }
      this.tell('phone', msg);
    }
  }

  async webSocketClose(ws) {
    const [role] = this.state.getTags(ws);
    if (role === 'laptop' && this.state.getWebSockets('laptop').filter((w) => w !== ws).length === 0) {
      this.tell('phone', { kind: 'state', laptop: 'offline' });
    }
  }
}
