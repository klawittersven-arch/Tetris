/*
 * Handy-Controller: verbindet sich per PeerJS mit dem Beamer und sendet
 * nur Tastendrücke. Die Spiellogik läuft komplett auf dem Laptop.
 */
(function () {
  'use strict';

  const PREFIX = 'tetris-duell-';
  const $ = s => document.querySelector(s);
  const params = new URLSearchParams(location.search);

  function peerOptions(server) {
    const opts = { debug: 1 };
    const m = /^([^:/]+)(?::(\d+))?$/.exec(server || '');
    if (m) {
      opts.host = m[1];
      opts.port = m[2] ? Number(m[2]) : 443;
      opts.secure = opts.port === 443;
      opts.path = '/';
    }
    return opts;
  }

  let peer = null;
  let conn = null;
  let code = (params.get('room') || '').toUpperCase();
  const prefSlot = parseInt(params.get('slot'), 10) || 0;
  let welcomed = false;
  let stopped = false;      // Raum voll / entfernt → nicht neu verbinden
  let retryTimer = null;
  let phase = 'lobby';
  let lastPong = 0;

  let clientId = null;
  try {
    clientId = localStorage.getItem('tetrisClientId');
    if (!clientId) {
      clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('tetrisClientId', clientId);
    }
    $('#name').value = localStorage.getItem('tetrisName') || '';
  } catch (e) {
    clientId = Math.random().toString(36).slice(2);
  }

  if (code) $('#codeLabel').hidden = true;
  else $('#code').value = '';

  function vibrate(p) {
    try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* egal */ }
  }

  function joinMsg(text, err) {
    const m = $('#joinMsg');
    m.textContent = text;
    m.className = 'msg' + (err ? ' err' : '');
  }

  // ---------- Verbindung ----------
  function join() {
    const name = $('#name').value.trim().slice(0, 16);
    if (!code) code = $('#code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) {
      code = '';
      $('#codeLabel').hidden = false;
      joinMsg('Bitte den 5-stelligen Code vom Beamer eingeben.', true);
      return;
    }
    try { localStorage.setItem('tetrisName', name); } catch (e) { /* egal */ }
    if (typeof Peer === 'undefined') { joinMsg('PeerJS konnte nicht geladen werden.', true); return; }
    $('#btnJoin').disabled = true;
    joinMsg('Verbinde …');
    stopped = false;
    requestWakeLock();

    if (peer && !peer.destroyed) { connect(); return; }
    peer = new Peer(peerOptions(params.get('server')));
    peer.on('open', connect);
    peer.on('disconnected', () => {
      if (!peer.destroyed) setTimeout(() => peer.reconnect(), 1500);
    });
    peer.on('error', err => {
      console.warn('Peer-Fehler', err.type, err);
      if (err.type === 'peer-unavailable') {
        if (welcomed) { scheduleRetry(); return; }
        backToJoin('Raum nicht gefunden. Ist die Beamer-Seite geöffnet und der Code richtig?');
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        if (welcomed) scheduleRetry();
        else backToJoin('Keine Internetverbindung zum Server. Bitte WLAN/mobile Daten prüfen.');
      } else if (err.type === 'browser-incompatible') {
        backToJoin('Dieser Browser unterstützt kein WebRTC.');
      }
    });
  }

  function backToJoin(text) {
    $('#pad').hidden = true;
    $('#join').hidden = false;
    $('#btnJoin').disabled = false;
    if (!params.get('room')) { code = ''; $('#codeLabel').hidden = false; }
    joinMsg(text, true);
    welcomed = false;
  }

  function connect() {
    if (stopped) return;
    if (conn) { try { conn.close(); } catch (e) { /* egal */ } }
    const c = peer.connect(PREFIX + code, { reliable: true });
    conn = c;
    c.on('open', () => {
      lastPong = Date.now();
      c.send({ type: 'hello', name: $('#name').value.trim().slice(0, 16), clientId, slot: prefSlot });
    });
    c.on('data', msg => {
      if (c !== conn) return;
      lastPong = Date.now();
      handleMessage(msg);
    });
    c.on('close', () => {
      if (c !== conn) return;
      setConnected(false);
      if (!stopped) scheduleRetry();
    });
    c.on('error', e => console.warn('Verbindungsfehler', e));
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (stopped) return;
    setStatus('Verbindung verloren …<br><small>verbinde neu</small>');
    retryTimer = setTimeout(() => {
      if (!peer || peer.destroyed) return;
      if (peer.disconnected) { peer.reconnect(); setTimeout(connect, 1000); }
      else connect();
    }, 2000);
  }

  // Lebenszeichen: Ping an den Beamer, und erkennen, wenn er nicht mehr antwortet
  setInterval(() => {
    if (!welcomed || !conn || !conn.open) return;
    send({ type: 'ping', t: Date.now() });
    if (Date.now() - lastPong > 6000) {
      const dead = conn;
      conn = null;
      try { dead.close(); } catch (e) { /* egal */ }
      setConnected(false);
      scheduleRetry();
    }
  }, 1000);

  window.addEventListener('pagehide', () => {
    try { if (conn) conn.close(); } catch (e) { /* egal */ }
  });

  function setConnected(on) {
    $('#pdot').className = on ? 'on' : 'off';
  }

  function send(msg) {
    try { if (conn && conn.open) conn.send(msg); } catch (e) { /* egal */ }
  }

  // ---------- Nachrichten vom Beamer ----------
  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'welcome':
        welcomed = true;
        clearTimeout(retryTimer);
        document.documentElement.style.setProperty('--accent', msg.color);
        $('#pname').textContent = `${msg.name} · Spieler ${msg.slot + 1}`;
        $('#join').hidden = true;
        $('#pad').hidden = false;
        setConnected(true);
        vibrate(30);
        break;
      case 'full':
        stopped = true;
        backToJoin('Das Spiel ist schon voll (2 Spieler).');
        break;
      case 'kicked':
        stopped = true;
        backToJoin('Du wurdest von der Lehrkraft entfernt.');
        break;
      case 'state':
        applyState(msg);
        break;
      case 'score':
        $('#info').textContent = `${msg.score.toLocaleString('de-DE')} Pkt · Level ${msg.level}`;
        break;
      case 'fx':
        if (msg.k === 'clear') vibrate(msg.n >= 4 ? [60, 40, 60, 40, 120] : [40]);
        if (msg.k === 'hit') {
          vibrate([120]);
          const pad = $('#pad');
          pad.classList.remove('hit');
          void pad.offsetWidth;
          pad.classList.add('hit');
        }
        break;
    }
  }

  function setStatus(html, big) {
    const s = $('#status');
    s.innerHTML = html;
    s.classList.toggle('big', !!big);
  }

  function applyState(st) {
    const prev = phase;
    phase = st.phase;
    const pad = $('#pad');
    pad.classList.remove('win', 'lose');
    pad.classList.toggle('inactive', phase !== 'playing');
    if (phase === 'playing') releaseAll(false);
    $('#info').textContent = `Runden ${st.rounds[0]} : ${st.rounds[1]}`;

    if (phase === 'lobby') {
      setStatus(`Bereit!<br><small>Warte auf den Start …</small>`);
    } else if (phase === 'countdown') {
      setStatus(String(st.count || ''), true);
      if (st.count) vibrate(20);
    } else if (phase === 'playing') {
      setStatus(`gegen ${escapeHtml(st.opponent)}`);
      if (prev === 'countdown') vibrate(80);
    } else if (phase === 'paused') {
      setStatus(st.pauseReason === 'disconnect' ? 'PAUSE<br><small>Warte auf andere/n Spieler/in …</small>' : 'PAUSE');
    } else if (phase === 'over') {
      if (st.result === 'win') {
        pad.classList.add('win');
        setStatus('🏆 GEWONNEN!');
        vibrate([80, 60, 80, 60, 200]);
      } else if (st.result === 'lose') {
        pad.classList.add('lose');
        setStatus('Verloren …<br><small>Nächste Runde startet am Beamer</small>');
        vibrate(300);
      } else {
        setStatus('Unentschieden!');
      }
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Tasten ----------
  const active = new Map(); // Button -> Anzahl Finger

  function press(btn) {
    const n = (active.get(btn) || 0) + 1;
    active.set(btn, n);
    if (n > 1) return;
    btn.classList.add('pressed');
    send({ type: 'input', a: btn.dataset.a, d: true });
    vibrate(8);
  }

  function release(btn) {
    const n = (active.get(btn) || 0) - 1;
    if (n > 0) { active.set(btn, n); return; }
    if (!active.has(btn)) return;
    active.delete(btn);
    btn.classList.remove('pressed');
    send({ type: 'input', a: btn.dataset.a, d: false });
  }

  function releaseAll(notify) {
    for (const btn of Array.from(active.keys())) {
      active.delete(btn);
      btn.classList.remove('pressed');
      if (notify) send({ type: 'input', a: btn.dataset.a, d: false });
    }
  }

  document.querySelectorAll('.btn').forEach(btn => {
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
      press(btn);
    });
    const up = e => { e.preventDefault(); release(btn); };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', () => {
      if (active.has(btn)) { active.set(btn, 1); release(btn); }
    });
    btn.addEventListener('contextmenu', e => e.preventDefault());
  });

  // Scrollen, Zoomen und Doppeltipp-Zoom auf dem Gamepad unterbinden
  ['touchstart', 'touchmove', 'touchend', 'gesturestart'].forEach(t => {
    $('#pad').addEventListener(t, e => e.preventDefault(), { passive: false });
  });
  document.addEventListener('contextmenu', e => { if (!$('#pad').hidden) e.preventDefault(); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseAll(true);
    else {
      requestWakeLock();
      if (welcomed && (!conn || !conn.open)) scheduleRetry();
    }
  });

  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* nicht unterstützt */ }
  }

  $('#btnJoin').addEventListener('click', join);
  ['#name', '#code'].forEach(s => $(s).addEventListener('keydown', e => { if (e.key === 'Enter') join(); }));
})();
