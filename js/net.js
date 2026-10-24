/*
 * Verbindung zum eigenen Cloudflare-Dienst (worker/index.js).
 * Alles läuft über normales HTTPS unter derselben Adresse wie das Spiel.
 * Beamer: WebSocket. Handys: WebSocket, und falls der nicht klappt,
 * automatisch HTTP-Abfragen alle 1,5 Sekunden (im Finale schneller).
 */
(function (root) {
  'use strict';

  const CLOUDFLARE = 'https://tetris.klawittersven.workers.dev';

  // Alte Links auf GitHub Pages zur Cloudflare-Adresse umleiten
  if (/\.github\.io$/i.test(location.hostname)) {
    const path = location.pathname.replace(/^\/tetris/i, '') || '/';
    location.replace(CLOUDFLARE + path + location.search);
  }

  const POLL_SLOW = 1500;
  const POLL_FAST = 250;

  function api(code) {
    return `/api/room/${encodeURIComponent(code)}`;
  }

  function wsUrl(code, params) {
    const u = new URL(api(code) + '/ws', location.href);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.search = new URLSearchParams(params).toString();
    return u.toString();
  }

  function parse(data) {
    try {
      const m = JSON.parse(data);
      return m && typeof m === 'object' ? m : null;
    } catch (e) {
      return null;
    }
  }

  const noop = () => {};

  // ---------- Beamer ----------
  function host(code, handlers) {
    const h = Object.assign({ onOpen: noop, onMessage: noop, onStatus: noop }, handlers);
    let ws = null;
    let closed = false;
    let retry = null;

    function open() {
      const w = new WebSocket(wsUrl(code, { role: 'host' }));
      ws = w;
      w.onopen = () => { h.onStatus('open'); h.onOpen(); };
      w.onmessage = e => {
        const m = parse(e.data);
        if (!m) return;
        if (m.type === 'replaced') { closed = true; h.onStatus('replaced'); return; }
        h.onMessage(m);
      };
      w.onclose = () => {
        if (closed || ws !== w) return;
        h.onStatus('reconnecting');
        retry = setTimeout(open, 2000);
      };
      w.onerror = noop;
    }
    open();

    function send(obj) {
      try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) { /* egal */ }
    }
    return {
      sendTo(id, msg) { send({ to: id, msg }); },
      broadcast(msg) { send({ to: '*', msg }); },
      close() {
        closed = true;
        clearTimeout(retry);
        try { if (ws) ws.close(); } catch (e) { /* egal */ }
      },
    };
  }

  // ---------- Handy ----------
  function player(code, id, handlers, options) {
    const h = Object.assign({ onOpen: noop, onMessage: noop, onStatus: noop }, handlers);
    let mode = options && options.transport === 'poll' ? 'poll' : 'ws';
    let ws = null;
    let closed = false;
    let wsFails = 0;
    let retry = null;
    let pollTimer = null;
    let pollOk = false;
    let inFlight = false;
    let fast = false;
    let outbox = [];

    function deliver(data) {
      const m = parse(data);
      if (m) h.onMessage(m);
    }

    function startWs() {
      const w = new WebSocket(wsUrl(code, { role: 'player', id }));
      ws = w;
      let opened = false;
      // Kommt keine Dauerverbindung zustande → HTTP-Abfragen
      const timeout = setTimeout(() => {
        if (opened || ws !== w) return;
        try { w.close(); } catch (e) { /* egal */ }
        toPolling();
      }, 5000);
      w.onopen = () => {
        opened = true;
        wsFails = 0;
        clearTimeout(timeout);
        h.onStatus('open');
        h.onOpen();
        const pending = outbox;
        outbox = [];
        pending.forEach(send);
      };
      w.onmessage = e => deliver(e.data);
      w.onclose = () => {
        clearTimeout(timeout);
        if (closed || ws !== w || mode !== 'ws') return;
        if (!opened) { toPolling(); return; }
        wsFails++;
        h.onStatus('lost');
        if (wsFails >= 3) toPolling();
        else retry = setTimeout(startWs, 1500);
      };
      w.onerror = noop;
    }

    function toPolling() {
      if (closed || mode === 'poll') return;
      mode = 'poll';
      ws = null;
      poll();
    }

    async function poll() {
      if (closed || inFlight) return;
      clearTimeout(pollTimer);
      inFlight = true;
      const msgs = outbox;
      outbox = [];
      try {
        const r = await fetch(api(code) + '/poll', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, msgs }),
          cache: 'no-store',
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        if (!pollOk) { pollOk = true; h.onStatus('open'); h.onOpen(); }
        (data.msgs || []).forEach(m => { if (m && typeof m === 'object') h.onMessage(m); });
      } catch (e) {
        outbox = msgs.concat(outbox).slice(-50);
        if (pollOk) { pollOk = false; h.onStatus('lost'); }
      }
      inFlight = false;
      if (!closed) pollTimer = setTimeout(poll, fast ? POLL_FAST : POLL_SLOW);
    }

    function send(msg) {
      if (mode === 'ws' && ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify(msg)); } catch (e) { outbox.push(msg); }
      } else {
        outbox.push(msg);
        if (outbox.length > 50) outbox.splice(0, outbox.length - 50);
      }
    }

    if (mode === 'poll') poll();
    else startWs();

    return {
      send,
      get mode() { return mode; },
      setFast(on) {
        const was = fast;
        fast = !!on;
        // beim Umschalten auf schnell sofort abfragen
        if (fast && !was && mode === 'poll' && !closed) poll();
      },
      close() {
        closed = true;
        clearTimeout(retry);
        clearTimeout(pollTimer);
        try { if (ws) ws.close(); } catch (e) { /* egal */ }
      },
    };
  }

  root.TetrisNet = { host, player };
})(window);
