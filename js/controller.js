/*
 * Handy: verbindet sich per PeerJS mit dem Beamer.
 * Runde 1: eigenes Tetris läuft auf dem Handy, nur der Punktestand geht an den Beamer.
 * Runde 2: die beiden Finalisten senden nur Tastendrücke, das Duell läuft am Beamer.
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
  let welcomed = false;
  let stopped = false;      // Raum voll / entfernt → nicht neu verbinden
  let retryTimer = null;
  let phase = 'lobby';
  let lastPong = 0;
  let st = null;            // letzter Zustand vom Beamer

  // Runde 1: lokales Spiel
  const { Game, COLS, VISIBLE } = window.Tetris;
  const { drawBoard, miniPiece } = window.TetrisRender;
  const DAS = 170, ARR = 50;
  let game = null;
  let gameSeed = null;       // Seed der aktuellen Runde 1 (vom Beamer)
  let running = false;
  let flash = null;          // kurze Einblendung { text, color, t }
  const rep = { left: false, right: false, dir: 0, das: 0, arr: 0 };

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
      c.send({
        type: 'hello', name: $('#name').value.trim().slice(0, 16), clientId,
        score: game ? game.score : 0, lines: game ? game.lines : 0,
      });
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
        $('#pname').textContent = msg.name;
        $('#join').hidden = true;
        $('#pad').hidden = false;
        setConnected(true);
        vibrate(30);
        break;
      case 'full':
        stopped = true;
        backToJoin('Das Spiel ist schon voll (30 Spieler/innen).');
        break;
      case 'kicked':
        stopped = true;
        backToJoin('Du wurdest von der Lehrkraft entfernt.');
        break;
      case 'state':
        applyState(msg);
        break;
      case 'score':
        $('#info').textContent = `${msg.score.toLocaleString('de-DE')} Pkt`;
        break;
      case 'fx':
        if (msg.k === 'clear') vibrate(msg.n >= 4 ? [60, 40, 60, 40, 120] : [40]);
        if (msg.k === 'hit') { vibrate([120]); hitFlash(); }
        break;
    }
  }

  function hitFlash() {
    const pad = $('#pad');
    pad.classList.remove('hit');
    void pad.offsetWidth;
    pad.classList.add('hit');
  }

  function setStatus(html, big, overlay) {
    const s = $('#status');
    s.innerHTML = html;
    s.classList.toggle('big', !!big);
    $('#stage').classList.toggle('overlay', !!overlay && !!html);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Ansicht: 'field' = eigenes Spielfeld + Knöpfe, 'pad' = nur Knöpfe, 'msg' = nur Text
  function setView(view) {
    $('#field').hidden = view !== 'field';
    $('#controls').hidden = view === 'msg';
    if (view === 'field') resize();
  }

  function applyState(s) {
    const prev = st ? st.phase : null;
    st = s;
    const pad = $('#pad');
    const finalist = s.slot >= 0;
    pad.classList.remove('win', 'lose');
    document.documentElement.style.setProperty('--accent', s.color || '#a78bfa');
    const fin = `<span class="hl">${escapeHtml(s.finalists[0])}</span> vs. <span class="hl">${escapeHtml(s.finalists[1])}</span>`;
    const targetTxt = Number(s.target).toLocaleString('de-DE');

    // Runde 1: lokales Spiel anlegen (gleiche Steinfolge für alle)
    if ((s.phase === 'r1-countdown' || s.phase === 'r1') && !s.qualified && gameSeed !== s.seed) {
      gameSeed = s.seed;
      game = new Game(s.seed);
      releaseAll(false);
    }
    if (s.phase === 'lobby') { game = null; gameSeed = null; }
    running = s.phase === 'r1' && !s.qualified;
    if (!running) releaseAll(true);
    pad.classList.toggle('inactive', !(running || (finalist && s.phase === 'playing')));

    switch (s.phase) {
      case 'lobby':
        setView('msg');
        $('#info').textContent = `${s.players} dabei`;
        setStatus('Du bist dabei! 🎮<small>Warte, bis die Lehrkraft Runde 1 startet …</small>');
        break;
      case 'r1-countdown':
        setView('field');
        updateInfo();
        setStatus(s.count ? `${s.count}<small>Tipp aufs Spielfeld = Stein fallen lassen</small>` : '', true, true);
        if (s.count) vibrate(20);
        break;
      case 'r1':
        if (s.qualified) {
          setView('msg');
          setStatus(`🎉 Geschafft!<small>Du hast ${targetTxt} Punkte erreicht und bist im Finale! Warte kurz …</small>`);
          if (prev === 'r1') vibrate([80, 60, 80, 60, 200]);
        } else {
          setView('field');
          updateInfo();
          setStatus('');
          if (prev === 'r1-countdown') vibrate(80);
        }
        break;
      case 'r1-done':
        setView('msg');
        $('#info').textContent = '';
        if (finalist) {
          setStatus(`🏆 Du bist im FINALE!<small>gegen ${escapeHtml(s.finalists[1 - s.slot])} – schau auf den Beamer.<br>Gleich steuerst du mit diesem Handy.</small>`);
          vibrate([80, 60, 200]);
        } else {
          setStatus(`Runde 1 ist vorbei!<small>Finale: ${fin}<br>Schau auf den Beamer 👀</small>`);
        }
        break;
      case 'countdown':
      case 'playing':
      case 'over':
        duelView(s, prev, fin);
        break;
      case 'paused':
        if (s.pausedFrom === 'r1' && game && !s.qualified) {
          setView('field');
          setStatus('PAUSE', false, true);
        } else if (s.pausedFrom === 'playing') {
          duelView(s, prev, fin);
        } else {
          setView('msg');
          setStatus('PAUSE');
        }
        break;
    }
  }

  function duelView(s, prev, fin) {
    const finalist = s.slot >= 0;
    const pad = $('#pad');
    if (!finalist) {
      setView('msg');
      $('#info').textContent = 'Zuschauer/in';
      let t = `Schau auf den Beamer 👀<small>Finale: ${fin}</small>`;
      if (s.phase === 'paused') t = `PAUSE<small>Finale: ${fin}</small>`;
      if (s.phase === 'over') t = `Runde vorbei!<small>Stand ${s.rounds[0]} : ${s.rounds[1]} – ${fin}</small>`;
      setStatus(t);
      return;
    }
    setView('pad');
    $('#info').textContent = `Runden ${s.rounds[0]} : ${s.rounds[1]}`;
    const opp = escapeHtml(s.finalists[1 - s.slot]);
    if (s.phase === 'countdown') {
      setStatus(s.count ? String(s.count) : '', true);
      if (s.count) vibrate(20);
    } else if (s.phase === 'playing') {
      setStatus(`FINALE<small>gegen ${opp} – schau auf den Beamer!<br><br>👆 Hier tippen = Stein fallen lassen</small>`);
      if (prev === 'countdown') vibrate(80);
    } else if (s.phase === 'paused') {
      setStatus(s.pauseReason === 'disconnect' ? 'PAUSE<small>Warte auf die Verbindung …</small>' : 'PAUSE');
    } else if (s.phase === 'over') {
      if (s.result === 'win') {
        pad.classList.add('win');
        setStatus('🏆 GEWONNEN!');
        vibrate([80, 60, 80, 60, 200]);
      } else if (s.result === 'lose') {
        pad.classList.add('lose');
        setStatus('Verloren …<small>Vielleicht gibt es eine Revanche!</small>');
        vibrate(300);
      } else {
        setStatus('Unentschieden!');
      }
    }
  }

  function updateInfo() {
    if (!st) return;
    const sc = game ? game.score : 0;
    $('#info').textContent = `${sc.toLocaleString('de-DE')} / ${Number(st.target).toLocaleString('de-DE')} Pkt`;
  }

  // ---------- Runde 1: Spielschleife & Zeichnen ----------
  const canvas = $('#field');
  const ctx = canvas.getContext('2d');
  const SIDE = 3.6;
  let cell = 20;

  function resize() {
    const stage = $('#stage').getBoundingClientRect();
    cell = Math.max(8, Math.floor(Math.min(stage.height / VISIBLE, stage.width / (COLS + SIDE))));
    const dpr = window.devicePixelRatio || 1;
    const w = (COLS + SIDE) * cell, h = VISIBLE * cell;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', () => { if (!$('#field').hidden) resize(); });

  function localPress(action, down) {
    if (action === 'left' || action === 'right') {
      rep[action] = down;
      const d = action === 'left' ? -1 : 1;
      if (down) {
        rep.dir = d; rep.das = 0; rep.arr = 0;
        if (running && game) game.move(d);
      } else if (rep.dir === d) {
        const other = action === 'left' ? 'right' : 'left';
        rep.dir = rep[other] ? -d : 0;
        rep.das = 0; rep.arr = 0;
      }
    } else if (action === 'cw' && down && running && game) {
      game.rotate(1);
    }
  }

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(now - last, 100);
    last = now;
    if (running && game) {
      if (rep.dir) {
        rep.das += dt;
        if (rep.das >= DAS) {
          rep.arr += dt;
          while (rep.arr >= ARR) {
            rep.arr -= ARR;
            if (!game.move(rep.dir)) { rep.arr = 0; break; }
          }
        }
      }
      game.update(dt);
      for (const ev of game.takeEvents()) {
        if (ev.type === 'lock') {
          send({ type: 'score', score: game.score, lines: game.lines });
          updateInfo();
        } else if (ev.type === 'clear') {
          vibrate(ev.lines >= 4 ? [60, 40, 60, 40, 120] : [40]);
          const words = ['', '+1 Reihe', 'DOPPEL!', 'TRIPLE!', 'TETRIS!'];
          flash = { text: words[ev.lines], color: '#facc15', t: 0 };
        } else if (ev.type === 'gameover') {
          // Neues Feld, Punkte zurück auf 0
          vibrate(400);
          hitFlash();
          flash = { text: 'Neustart: 0 Punkte', color: '#ff4d5e', t: -600 };
          game = new Game((Math.random() * 2 ** 32) >>> 0);
          send({ type: 'reset' });
          updateInfo();
        }
      }
    }
    if (flash) { flash.t += dt; if (flash.t > 1300) flash = null; }
    if (!$('#field').hidden) draw();
    requestAnimationFrame(loop);
  }

  function draw() {
    const c = cell;
    const W = (COLS + SIDE) * c, H = VISIBLE * c;
    ctx.clearRect(0, 0, W, H);
    drawBoard(ctx, game, 0, 0, c);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#a78bfa';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, COLS * c - 2, H - 2);

    const sx = COLS * c + c * 0.3, sw = (SIDE - 0.3) * c;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#8a97b8';
    ctx.font = `700 ${Math.round(c * 0.6)}px system-ui, sans-serif`;
    ctx.fillText('NÄCHSTE', sx + sw / 2, c * 0.6);
    ctx.fillStyle = '#0d1424';
    ctx.fillRect(sx, c * 1.1, sw, c * 3);
    if (game) miniPiece(ctx, game.nextPieces(1)[0], sx + sw / 2, c * 2.6, c * 0.7);

    ctx.fillStyle = '#8a97b8';
    ctx.font = `700 ${Math.round(c * 0.6)}px system-ui, sans-serif`;
    ctx.fillText('PUNKTE', sx + sw / 2, c * 5.4);
    ctx.fillStyle = '#e8ecf8';
    ctx.font = `800 ${Math.round(c * 0.95)}px system-ui, sans-serif`;
    ctx.fillText(game ? game.score.toLocaleString('de-DE') : '0', sx + sw / 2, c * 6.5);
    ctx.fillStyle = '#8a97b8';
    ctx.font = `700 ${Math.round(c * 0.6)}px system-ui, sans-serif`;
    ctx.fillText('ZIEL', sx + sw / 2, c * 8);
    ctx.fillStyle = '#facc15';
    ctx.font = `800 ${Math.round(c * 0.95)}px system-ui, sans-serif`;
    ctx.fillText(st ? Number(st.target).toLocaleString('de-DE') : '', sx + sw / 2, c * 9.1);

    // Fortschrittsbalken zum Ziel
    if (game && st) {
      const p = Math.min(1, game.score / st.target);
      ctx.fillStyle = '#0d1424';
      ctx.fillRect(sx + sw * 0.3, c * 10.2, sw * 0.4, c * 9.5);
      ctx.fillStyle = '#facc15';
      ctx.fillRect(sx + sw * 0.3, c * (10.2 + 9.5 * (1 - p)), sw * 0.4, c * 9.5 * p);
    }

    if (flash && flash.t > 0) {
      ctx.globalAlpha = Math.max(0, 1 - flash.t / 1300);
      ctx.fillStyle = flash.color;
      ctx.font = `900 ${Math.round(c * 1.2)}px system-ui, sans-serif`;
      ctx.shadowColor = 'rgba(0,0,0,.9)';
      ctx.shadowBlur = 8;
      ctx.fillText(flash.text, COLS * c / 2, H * 0.4 - flash.t / 1300 * c, COLS * c * 0.92);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  // ---------- Tasten ----------
  const active = new Map(); // Button -> Anzahl Finger

  function route(btn, down) {
    const a = btn.dataset.a;
    if (st && st.phase === 'r1') localPress(a, down);
    else if (st && st.slot >= 0) send({ type: 'input', a, d: down });
  }

  function press(btn) {
    const n = (active.get(btn) || 0) + 1;
    active.set(btn, n);
    if (n > 1) return;
    btn.classList.add('pressed');
    route(btn, true);
    vibrate(8);
  }

  function release(btn) {
    const n = (active.get(btn) || 0) - 1;
    if (n > 0) { active.set(btn, n); return; }
    if (!active.has(btn)) return;
    active.delete(btn);
    btn.classList.remove('pressed');
    route(btn, false);
  }

  function releaseAll(notify) {
    for (const btn of Array.from(active.keys())) {
      active.delete(btn);
      btn.classList.remove('pressed');
      if (notify && st && st.slot >= 0) send({ type: 'input', a: btn.dataset.a, d: false });
    }
    rep.left = rep.right = false;
    rep.dir = 0;
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

  // Scrollen, Zoomen und Doppeltipp-Zoom unterbinden
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

  // Tippen in die Bildschirmmitte (Spielfeld bzw. Statusfläche) = Stein sofort fallen lassen
  $('#stage').addEventListener('pointerdown', e => {
    e.preventDefault();
    if (!st) return;
    let dropped = false;
    if (st.phase === 'r1' && running && game && !game.over) {
      game.hardDrop();
      dropped = true;
    } else if (st.phase === 'playing' && st.slot >= 0) {
      send({ type: 'input', a: 'drop', d: true });
      dropped = true;
    }
    if (dropped) {
      vibrate(15);
      const stage = $('#stage');
      stage.classList.remove('tap');
      void stage.offsetWidth;
      stage.classList.add('tap');
    }
  });

  // Zugriff für automatische Tests
  window.__tetris = { get game() { return game; }, send };

  $('#btnJoin').addEventListener('click', join);
  ['#name', '#code'].forEach(s => $(s).addEventListener('keydown', e => { if (e.key === 'Enter') join(); }));
  requestAnimationFrame(loop);
})();
