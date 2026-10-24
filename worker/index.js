/*
 * Cloudflare Worker: liefert das Spiel aus und vermittelt die Nachrichten
 * zwischen Beamer und Handys. Pro Raum gibt es ein Durable Object („Room“),
 * das nur Nachrichten weiterreicht – die Spiellogik läuft im Browser.
 *
 *   GET  /api/room/<CODE>/ws?role=host            WebSocket des Beamers
 *   GET  /api/room/<CODE>/ws?role=player&id=<id>  WebSocket eines Handys
 *   POST /api/room/<CODE>/poll  {id, msgs}         Reserve ohne WebSocket
 */
import { DurableObject } from 'cloudflare:workers';

const MAX_QUEUE = 100;        // gepufferte Nachrichten pro Handy (Polling)
const POLL_FORGET = 60000;    // ms: so lange gilt ein Handy ohne Poll als „noch da“

function cleanId(v) {
  const s = String(v || '');
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : '';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.queues = new Map();   // id -> Nachrichten für Handys im Polling-Modus
    this.lastPoll = new Map(); // id -> Zeitpunkt des letzten Polls
  }

  host() {
    return this.ctx.getWebSockets('host')[0] || null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/ws')) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket erwartet', { status: 426 });
      const role = url.searchParams.get('role');
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      if (role === 'host') {
        // Ein neu geöffneter Beamer ersetzt einen alten (z. B. nach Neuladen)
        for (const old of this.ctx.getWebSockets('host')) {
          try { old.send(JSON.stringify({ type: 'replaced' })); old.close(4000, 'replaced'); } catch (e) { /* egal */ }
        }
        this.ctx.acceptWebSocket(server, ['host']);
        server.serializeAttachment({ role: 'host' });
      } else {
        const id = cleanId(url.searchParams.get('id'));
        if (!id) return new Response('ungültige ID', { status: 400 });
        for (const old of this.ctx.getWebSockets('p:' + id)) {
          try { old.serializeAttachment({ role: 'old' }); old.close(4001, 'replaced'); } catch (e) { /* egal */ }
        }
        this.ctx.acceptWebSocket(server, ['p:' + id]);
        server.serializeAttachment({ role: 'player', id });
        this.queues.delete(id);
        this.lastPoll.delete(id);
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith('/poll') && request.method === 'POST') {
      let body = null;
      try { body = await request.json(); } catch (e) { /* unten abgefangen */ }
      const id = cleanId(body && body.id);
      if (!id) return json({ error: 'ungültige ID' }, 400);
      this.lastPoll.set(id, Date.now());
      const msgs = Array.isArray(body.msgs) ? body.msgs.slice(0, 50) : [];
      for (const m of msgs) this.fromPlayer(id, m);
      const out = this.queues.get(id) || [];
      this.queues.set(id, []);
      return json({ msgs: out });
    }

    return new Response('Nicht gefunden', { status: 404 });
  }

  fromPlayer(id, msg) {
    if (!msg || typeof msg !== 'object') return;
    const h = this.host();
    if (!h) {
      if (msg.type === 'hello') this.toPlayer(id, { type: 'nohost' });
      return;
    }
    msg.from = id;
    try { h.send(JSON.stringify(msg)); } catch (e) { /* egal */ }
  }

  toPlayer(id, msg) {
    const socks = this.ctx.getWebSockets('p:' + id);
    if (socks.length) {
      const s = JSON.stringify(msg);
      for (const w of socks) { try { w.send(s); } catch (e) { /* egal */ } }
      return;
    }
    const seen = this.lastPoll.get(id);
    if (!seen || Date.now() - seen > POLL_FORGET) return;
    let q = this.queues.get(id);
    if (!q) { q = []; this.queues.set(id, q); }
    q.push(msg);
    if (q.length > MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE);
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const w of this.ctx.getWebSockets()) {
      const att = w.deserializeAttachment() || {};
      if (att.role === 'player') { try { w.send(s); } catch (e) { /* egal */ } }
    }
    const now = Date.now();
    for (const [id, t] of this.lastPoll) {
      if (now - t > POLL_FORGET) { this.lastPoll.delete(id); this.queues.delete(id); continue; }
      this.toPlayer(id, msg);
    }
  }

  async webSocketMessage(ws, data) {
    const att = ws.deserializeAttachment() || {};
    let msg = null;
    try { msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (att.role === 'host') {
      if (msg.to === '*') this.broadcast(msg.msg);
      else if (msg.to) { const id = cleanId(msg.to); if (id) this.toPlayer(id, msg.msg); }
    } else if (att.role === 'player') {
      this.fromPlayer(att.id, msg);
    }
  }

  async webSocketClose(ws, code, reason) {
    this.closed(ws);
    try { ws.close(code, reason); } catch (e) { /* schon zu */ }
  }

  async webSocketError(ws) {
    this.closed(ws);
  }

  closed(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.role !== 'player') return;
    // Nur melden, wenn das Handy nicht schon neu verbunden ist
    const still = this.ctx.getWebSockets('p:' + att.id).some(w => w !== ws && (w.deserializeAttachment() || {}).role === 'player');
    if (still) return;
    const h = this.host();
    if (h) { try { h.send(JSON.stringify({ type: 'bye', from: att.id })); } catch (e) { /* egal */ } }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/(ws|poll)$/);
    if (m) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return new Response('Nicht gefunden', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
