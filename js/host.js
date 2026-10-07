/*
 * Beamer-Ansicht: verwaltet die Verbindungen zu den Handys (PeerJS/WebRTC),
 * führt beide Spiele aus und zeichnet sie.
 */
(function () {
  'use strict';

  const { Game, SHAPES, COLS, HIDDEN, VISIBLE } = window.Tetris;
  const PREFIX = 'tetris-duell-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const DAS = 160;   // ms bis zur Wiederholung beim Gedrückthalten
  const ARR = 45;    // ms zwischen Wiederholungen
  const COLORS = {
    I: '#22d3ee', O: '#facc15', T: '#a855f7', S: '#22c55e',
    Z: '#ef4444', J: '#3b82f6', L: '#f97316', G: '#64748b',
  };
  const PLAYER_COLORS = ['#3da5ff', '#ff9f1c'];

  const $ = (s, el = document) => el.querySelector(s);

  // Optional eigener PeerJS-Server: index.html?server=host:port (wird an die Handys weitergegeben)
  const serverParam = new URLSearchParams(location.search).get('server') || '';
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

  // ---------- Zustand ----------
  let peer = null;
  let roomCode = null;
  let phase = 'lobby';          // lobby | countdown | playing | paused | over
  let pauseReason = '';
  let games = [null, null];
  let rounds = [0, 0];
  let lastResult = null;        // { winner: 0|1|-1 }
  let countdownTimer = null;
  const slots = [0, 1].map(i => ({ conn: null, clientId: null, name: '', connected: false, kbd: false, lastSeen: 0 }));
  const inputs = [0, 1].map(() => freshInput());
  const popups = [[], []];

  function freshInput() {
    return { left: false, right: false, down: false, dir: 0, das: 0, arr: 0 };
  }

  function playerName(i) {
    return slots[i].name || `Spieler ${i + 1}`;
  }

  // ---------- Netzwerk ----------
  function newCode() {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return c;
  }

  function setNet(text, cls) {
    const el = $('#netStatus');
    el.textContent = text;
    el.className = 'net ' + (cls || '');
  }

  function startPeer(code, attempt) {
    roomCode = code;
    try { sessionStorage.setItem('tetrisRoom', code); } catch (e) { /* egal */ }
    setNet('Verbinde mit dem Server …');
    peer = new Peer(PREFIX + code, peerOptions(serverParam));

    peer.on('open', () => {
      setNet('Bereit – Handys können beitreten.', 'ok');
      renderJoinInfo();
    });
    peer.on('connection', handleConnection);
    peer.on('disconnected', () => {
      setNet('Verbindung zum Server unterbrochen – versuche erneut …', 'err');
      setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000);
    });
    peer.on('error', err => {
      console.warn('Peer-Fehler', err.type, err);
      if (err.type === 'unavailable-id') {
        // Code ist (noch) belegt, z. B. nach Neuladen der Seite
        peer.destroy();
        if (attempt < 3) setTimeout(() => startPeer(code, attempt + 1), 2500);
        else startPeer(newCode(), 0);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        setNet('Keine Verbindung zum Server. Ist der Laptop online? Neuer Versuch …', 'err');
        setTimeout(() => {
          if (!peer || peer.destroyed) startPeer(code, attempt);
          else if (peer.disconnected) peer.reconnect();
        }, 3000);
      } else if (err.type === 'browser-incompatible') {
        setNet('Dieser Browser unterstützt kein WebRTC. Bitte Chrome, Edge oder Firefox verwenden.', 'err');
      }
    });
  }

  function joinUrl(slot) {
    const u = new URL('controller.html', location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('room', roomCode);
    if (slot !== undefined) u.searchParams.set('slot', String(slot + 1));
    if (serverParam) u.searchParams.set('server', serverParam);
    return u.toString();
  }

  function makeQr(el, text) {
    el.innerHTML = '';
    if (typeof QRCode === 'undefined') { el.textContent = text; return; }
    new QRCode(el, { text, width: 512, height: 512, correctLevel: QRCode.CorrectLevel.M });
  }

  function renderJoinInfo() {
    makeQr($('#qr0'), joinUrl(0));
    makeQr($('#qr1'), joinUrl(1));
    makeQr($('#miniQr'), joinUrl());
    document.querySelectorAll('.roomcode').forEach(el => { el.textContent = roomCode; });
    const base = new URL('controller.html', location.href);
    $('#joinUrl').textContent = base.host + base.pathname;
  }

  function isFree(i) {
    const s = slots[i];
    return !s.clientId || (!s.connected && phase === 'lobby');
  }

  function handleConnection(conn) {
    let slotIndex = -1;

    conn.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (slotIndex >= 0 && slots[slotIndex].conn === conn) slots[slotIndex].lastSeen = Date.now();
      if (msg.type === 'hello') {
        let i = slots.findIndex(s => s.clientId && s.clientId === msg.clientId);
        if (i < 0) {
          const pref = msg.slot === 1 || msg.slot === 2 ? msg.slot - 1 : 0;
          i = isFree(pref) ? pref : (isFree(1 - pref) ? 1 - pref : -1);
        }
        if (i < 0) {
          safeSend(conn, { type: 'full' });
          setTimeout(() => conn.close(), 500);
          return;
        }
        const s = slots[i];
        if (s.conn && s.conn !== conn) { try { s.conn.close(); } catch (e) { /* egal */ } }
        slotIndex = i;
        s.conn = conn;
        s.clientId = String(msg.clientId || Math.random());
        s.name = String(msg.name || '').trim().slice(0, 16);
        s.connected = true;
        s.lastSeen = Date.now();
        s.kbd = false;
        safeSend(conn, { type: 'welcome', slot: i, color: PLAYER_COLORS[i], name: playerName(i) });
        sendState(i);
        updatePlayerUI();
        if (phase === 'paused' && pauseReason === 'disconnect' && allConnected()) resume();
      } else if (msg.type === 'input' && slotIndex >= 0 && slots[slotIndex].conn === conn) {
        handleInput(slotIndex, msg.a, !!msg.d);
      } else if (msg.type === 'ping') {
        safeSend(conn, { type: 'pong', t: msg.t });
      }
    });

    conn.on('close', () => {
      if (slotIndex >= 0) dropSlot(slotIndex, conn);
    });
    conn.on('error', e => console.warn('Verbindungsfehler', e));
  }

  // Verbindung eines Platzes als getrennt markieren
  function dropSlot(i, conn) {
    const s = slots[i];
    if (s.conn !== conn) return;
    s.connected = false;
    s.conn = null;
    inputs[i] = freshInput();
    if (games[i]) games[i].softDrop = false;
    if (phase === 'lobby') { s.clientId = null; s.name = ''; }
    if (phase === 'playing' || phase === 'countdown') pause('disconnect');
    updatePlayerUI();
    try { conn.close(); } catch (e) { /* egal */ }
  }

  // Handys senden jede Sekunde ein Ping – bleibt es aus, gilt das Handy als getrennt
  setInterval(() => {
    slots.forEach((s, i) => {
      if (s.connected && Date.now() - s.lastSeen > 5000) dropSlot(i, s.conn);
    });
  }, 1000);

  function allConnected() {
    return slots.every(s => !s.clientId || s.connected);
  }

  function safeSend(conn, msg) {
    try { if (conn && conn.open) conn.send(msg); } catch (e) { /* egal */ }
  }

  function send(i, msg) {
    if (slots[i].connected) safeSend(slots[i].conn, msg);
  }

  function sendState(i, extra) {
    const g = games[i];
    let result = null;
    if (phase === 'over' && lastResult) {
      result = lastResult.winner === -1 ? 'draw' : (lastResult.winner === i ? 'win' : 'lose');
    }
    send(i, Object.assign({
      type: 'state', phase, pauseReason, slot: i, name: playerName(i),
      opponent: playerName(1 - i), rounds: [rounds[i], rounds[1 - i]], result,
      score: g ? g.score : 0, lines: g ? g.lines : 0, level: g ? g.level : 1,
    }, extra || {}));
  }

  function broadcastState(extra) {
    sendState(0, extra);
    sendState(1, extra);
  }

  // ---------- Eingaben ----------
  function handleInput(i, action, down) {
    const inp = inputs[i];
    const g = games[i];
    const active = phase === 'playing' && g && !g.over;

    if (action === 'left' || action === 'right') {
      inp[action] = down;
      const d = action === 'left' ? -1 : 1;
      if (down) {
        inp.dir = d; inp.das = 0; inp.arr = 0;
        if (active) g.move(d);
      } else if (inp.dir === d) {
        const other = action === 'left' ? 'right' : 'left';
        inp.dir = inp[other] ? -d : 0;
        inp.das = 0; inp.arr = 0;
      }
      return;
    }
    if (action === 'down') {
      inp.down = down;
      if (g) g.softDrop = down && active;
      return;
    }
    if (!down || !active) return;
    if (action === 'cw') g.rotate(1);
    else if (action === 'ccw') g.rotate(-1);
    else if (action === 'drop') g.hardDrop();
    else if (action === 'hold') g.holdPiece();
  }

  function updateAutoRepeat(i, dt) {
    const inp = inputs[i];
    const g = games[i];
    g.softDrop = inp.down;
    if (!inp.dir) return;
    inp.das += dt;
    if (inp.das < DAS) return;
    inp.arr += dt;
    while (inp.arr >= ARR) {
      inp.arr -= ARR;
      if (!g.move(inp.dir)) { inp.arr = 0; break; }
    }
  }

  // Tastatur: Lehrkraft + Testspieler
  const KEYMAP = {
    KeyA: [0, 'left'], KeyD: [0, 'right'], KeyS: [0, 'down'], KeyW: [0, 'cw'],
    KeyQ: [0, 'ccw'], KeyE: [0, 'hold'], Space: [0, 'drop'],
    ArrowLeft: [1, 'left'], ArrowRight: [1, 'right'], ArrowDown: [1, 'down'], ArrowUp: [1, 'cw'],
    Period: [1, 'ccw'], Slash: [1, 'hold'], Minus: [1, 'hold'], ShiftRight: [1, 'drop'],
  };

  document.addEventListener('keydown', e => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      if (phase === 'lobby') startMatch();
      else if (phase === 'over') startRound();
      return;
    }
    if (e.code === 'KeyP') { togglePause(); return; }
    if (e.code === 'Escape') { toLobby(); return; }
    const m = KEYMAP[e.code];
    if (!m) return;
    e.preventDefault();
    if (e.repeat) return;
    if (!slots[m[0]].connected) { slots[m[0]].kbd = true; updatePlayerUI(); }
    handleInput(m[0], m[1], true);
  });
  document.addEventListener('keyup', e => {
    const m = KEYMAP[e.code];
    if (m) handleInput(m[0], m[1], false);
  });

  // ---------- Spielablauf ----------
  function startMatch() {
    rounds = [0, 0];
    startRound();
  }

  function startRound() {
    const seed = (Math.random() * 2 ** 32) >>> 0;
    games = [new Game(seed, seed ^ 0x1234567), new Game(seed, seed ^ 0x7654321)];
    inputs[0] = freshInput();
    inputs[1] = freshInput();
    popups[0] = []; popups[1] = [];
    lastResult = null;
    $('#lobby').hidden = true;
    updateRounds();
    requestWakeLock();
    countdown(() => { phase = 'playing'; broadcastState(); });
  }

  function countdown(done) {
    clearTimeout(countdownTimer);
    phase = 'countdown';
    let n = 3;
    const tick = () => {
      if (phase !== 'countdown') return;
      if (n > 0) {
        showBanner(String(n), '', false);
        broadcastState({ count: n });
        n--;
        countdownTimer = setTimeout(tick, 800);
      } else {
        showBanner('LOS!', '', false);
        countdownTimer = setTimeout(() => { if (phase === 'playing') hideBanner(); }, 600);
        done();
      }
    };
    tick();
  }

  function pause(reason) {
    if (phase !== 'playing' && phase !== 'countdown') return;
    clearTimeout(countdownTimer);
    phase = 'paused';
    pauseReason = reason || 'teacher';
    for (const g of games) if (g) g.softDrop = false;
    const sub = reason === 'disconnect'
      ? 'Ein Handy hat die Verbindung verloren – bitte erneut den QR-Code scannen.'
      : 'Weiter mit P';
    showBanner('PAUSE', sub, false);
    broadcastState();
  }

  function resume() {
    if (phase !== 'paused') return;
    pauseReason = '';
    countdown(() => { phase = 'playing'; broadcastState(); });
  }

  function togglePause() {
    if (phase === 'paused') resume();
    else pause('teacher');
  }

  function toLobby() {
    clearTimeout(countdownTimer);
    phase = 'lobby';
    pauseReason = '';
    games = [null, null];
    rounds = [0, 0];
    for (const s of slots) {
      if (!s.connected) { s.clientId = null; s.name = ''; }
      s.kbd = false;
    }
    hideBanner();
    $('#lobby').hidden = false;
    updatePlayerUI();
    updateRounds();
    broadcastState();
  }

  function finishRound() {
    const over = games.map(g => g.over);
    let winner = -1;
    if (over[0] && !over[1]) winner = 1;
    else if (over[1] && !over[0]) winner = 0;
    if (winner >= 0) rounds[winner]++;
    lastResult = { winner };
    phase = 'over';
    updateRounds();
    if (winner >= 0) {
      showBanner(`${playerName(winner)} gewinnt!`, `Stand ${rounds[0]} : ${rounds[1]}`, true, PLAYER_COLORS[winner]);
    } else {
      showBanner('Unentschieden!', `Stand ${rounds[0]} : ${rounds[1]}`, true);
    }
    broadcastState();
  }

  function handleEvents(i) {
    const g = games[i];
    for (const ev of g.takeEvents()) {
      if (ev.type === 'clear') {
        const words = ['', '', 'DOPPEL', 'TRIPLE', 'TETRIS!'];
        if (words[ev.lines]) addPopup(i, words[ev.lines], ev.lines === 4 ? '#22d3ee' : '#fff');
        if (ev.b2b) addPopup(i, 'Back-to-Back', '#facc15');
        if (ev.combo >= 2) addPopup(i, `Combo ×${ev.combo}`, '#a3e635');
        if (ev.attack > 0) {
          games[1 - i].receiveGarbage(ev.attack);
          addPopup(i, `+${ev.attack} ➜`, '#ff4d5e');
        }
        send(i, { type: 'fx', k: 'clear', n: ev.lines });
      } else if (ev.type === 'garbage') {
        send(i, { type: 'fx', k: 'hit', n: ev.lines });
      } else if (ev.type === 'lock') {
        send(i, { type: 'score', score: g.score, lines: g.lines, level: g.level });
      }
    }
  }

  function addPopup(i, text, color) {
    popups[i].push({ text, color, t: 0 });
    if (popups[i].length > 4) popups[i].shift();
  }

  // ---------- Hauptschleife ----------
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(now - last, 100);
    last = now;
    if (phase === 'playing') {
      for (let i = 0; i < 2; i++) {
        updateAutoRepeat(i, dt);
        games[i].update(dt);
      }
      handleEvents(0);
      handleEvents(1);
      if (games[0].over || games[1].over) finishRound();
    }
    for (let i = 0; i < 2; i++) {
      popups[i].forEach(p => { p.t += dt; });
      popups[i] = popups[i].filter(p => p.t < 1400);
      drawPlayer(i);
    }
    requestAnimationFrame(loop);
  }

  // ---------- Darstellung ----------
  const canvases = [$('#p0 canvas'), $('#p1 canvas')];
  const ctxs = canvases.map(c => c.getContext('2d'));
  const SIDE = 5, GAP1 = 0.4, METER = 0.6, GAP2 = 0.25;
  const TOTAL_W = SIDE + GAP1 + METER + GAP2 + COLS;
  let cell = 30;

  function resize() {
    const header = $('.pname').getBoundingClientRect().height + innerHeight * 0.04;
    const byH = (innerHeight - header) / VISIBLE;
    const byW = (innerWidth * 0.82 - Math.max(150, innerWidth * 0.15)) / 2 / TOTAL_W;
    cell = Math.max(8, Math.floor(Math.min(byH, byW)));
    const dpr = window.devicePixelRatio || 1;
    canvases.forEach((c, i) => {
      c.style.width = `${TOTAL_W * cell}px`;
      c.style.height = `${VISIBLE * cell}px`;
      c.width = Math.round(TOTAL_W * cell * dpr);
      c.height = Math.round(VISIBLE * cell * dpr);
      ctxs[i].setTransform(dpr, 0, 0, dpr, 0, 0);
    });
  }
  window.addEventListener('resize', resize);

  function layout(i) {
    // Spieler 1: Seitenleiste links, Spieler 2: rechts (gespiegelt)
    if (i === 0) {
      return { side: 0, meter: (SIDE + GAP1) * cell, board: (SIDE + GAP1 + METER + GAP2) * cell };
    }
    return { board: 0, meter: (COLS + GAP2) * cell, side: (COLS + GAP2 + METER + GAP1) * cell };
  }

  function block(ctx, x, y, s, color, alpha) {
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    ctx.fillStyle = color;
    ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
    const b = Math.max(2, s * 0.14);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(x + 1, y + 1, s - 2, b);
    ctx.fillRect(x + 1, y + 1, b, s - 2);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(x + 1, y + s - 1 - b, s - 2, b);
    ctx.fillRect(x + s - 1 - b, y + 1, b, s - 2);
    ctx.globalAlpha = 1;
  }

  function miniPiece(ctx, type, cx, cy, s, dim) {
    const cells = SHAPES[type][0];
    const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = (maxX - minX + 1) * s, h = (maxY - minY + 1) * s;
    for (const [x, y] of cells) {
      block(ctx, cx - w / 2 + (x - minX) * s, cy - h / 2 + (y - minY) * s, s, dim ? '#475569' : COLORS[type]);
    }
  }

  function drawPlayer(i) {
    const ctx = ctxs[i];
    const c = cell;
    const W = TOTAL_W * c, H = VISIBLE * c;
    const L = layout(i);
    const g = games[i];
    const pc = PLAYER_COLORS[i];
    ctx.clearRect(0, 0, W, H);

    // Spielfeld
    ctx.fillStyle = '#070b16';
    ctx.fillRect(L.board, 0, COLS * c, H);
    ctx.strokeStyle = 'rgba(80,100,150,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < COLS; x++) { ctx.moveTo(L.board + x * c + 0.5, 0); ctx.lineTo(L.board + x * c + 0.5, H); }
    for (let y = 1; y < VISIBLE; y++) { ctx.moveTo(L.board, y * c + 0.5); ctx.lineTo(L.board + COLS * c, y * c + 0.5); }
    ctx.stroke();

    if (g) {
      for (let y = HIDDEN; y < HIDDEN + VISIBLE; y++) {
        for (let x = 0; x < COLS; x++) {
          const t = g.board[y][x];
          if (t) block(ctx, L.board + x * c, (y - HIDDEN) * c, c, g.over ? '#334155' : COLORS[t]);
        }
      }
      if (!g.over && g.current) {
        const gy = g.ghostY();
        const ghost = { ...g.current, y: gy };
        for (const [x, y] of g.cells(ghost)) {
          if (y < HIDDEN) continue;
          ctx.strokeStyle = COLORS[g.current.type];
          ctx.globalAlpha = 0.85;
          ctx.lineWidth = 3;
          ctx.strokeRect(L.board + x * c + 2, (y - HIDDEN) * c + 2, c - 4, c - 4);
          ctx.globalAlpha = 0.22;
          ctx.fillStyle = COLORS[g.current.type];
          ctx.fillRect(L.board + x * c + 2, (y - HIDDEN) * c + 2, c - 4, c - 4);
          ctx.globalAlpha = 1;
        }
        // Lock-Verzögerung durch leichtes Abdunkeln sichtbar machen
        const fade = g.onGround() ? Math.min(g.lockTimer / 500, 1) * 0.35 : 0;
        for (const [x, y] of g.cells(g.current)) {
          if (y < HIDDEN) continue;
          block(ctx, L.board + x * c, (y - HIDDEN) * c, c, COLORS[g.current.type], 1 - fade);
        }
      }
    }

    ctx.strokeStyle = pc;
    ctx.lineWidth = 3;
    ctx.strokeRect(L.board + 1.5, 1.5, COLS * c - 3, H - 3);

    // Müll-Anzeige
    ctx.fillStyle = '#0d1424';
    ctx.fillRect(L.meter, 0, METER * c, H);
    if (g) {
      const p = Math.min(g.pendingTotal(), VISIBLE);
      if (p > 0) {
        ctx.fillStyle = p >= 8 ? '#ff2d45' : '#ff6b3d';
        ctx.fillRect(L.meter + 2, H - p * c, METER * c - 4, p * c);
      }
    }

    // Seitenleiste
    const sx = L.side, sw = SIDE * c;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = (txt, y) => {
      ctx.fillStyle = '#8a97b8';
      ctx.font = `700 ${Math.round(c * 0.55)}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(txt, sx + sw / 2, y * c);
    };
    const value = (txt, y) => {
      ctx.fillStyle = '#e8ecf8';
      ctx.font = `800 ${Math.round(c * 0.85)}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(txt, sx + sw / 2, y * c);
    };
    const box = (y, h) => {
      ctx.fillStyle = '#0d1424';
      ctx.fillRect(sx, y * c, sw, h * c);
      ctx.strokeStyle = '#24304d';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 1, y * c + 1, sw - 2, h * c - 2);
    };

    label('HALTEN', 0.45);
    box(0.9, 3);
    if (g && g.hold) miniPiece(ctx, g.hold, sx + sw / 2, 2.4 * c, c * 0.8, !g.canHold);

    label('NÄCHSTE', 4.4);
    box(4.85, 8.6);
    if (g) {
      g.nextPieces(3).forEach((t, k) => {
        miniPiece(ctx, t, sx + sw / 2, (6.3 + k * 2.7) * c, c * (k === 0 ? 0.8 : 0.65));
      });
    }

    label('PUNKTE', 14.3);
    value(g ? g.score.toLocaleString('de-DE') : '0', 15.25);
    label('REIHEN', 16.55);
    value(g ? String(g.lines) : '0', 17.5);
    label('LEVEL', 18.8);
    value(g ? String(g.level) : '1', 19.6);

    // Einblendungen (TETRIS!, Combo, Angriff)
    popups[i].forEach((p, k) => {
      const a = 1 - p.t / 1400;
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = p.color;
      ctx.font = `900 ${Math.round(c * 1.1)}px "Segoe UI", system-ui, sans-serif`;
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 8;
      ctx.fillText(p.text, L.board + COLS * c / 2, (7 + k * 1.4) * c - p.t / 1400 * c);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    });

    // Ergebnis auf dem Feld
    if (g && phase === 'over') {
      const won = lastResult && lastResult.winner === i;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(L.board, H * 0.15 - 1.6 * c, COLS * c, 3.2 * c);
      ctx.fillStyle = won ? '#2ecc71' : (lastResult && lastResult.winner === -1 ? '#e8ecf8' : '#ff4d5e');
      ctx.font = `900 ${Math.round(c * 1.6)}px "Segoe UI", system-ui, sans-serif`;
      const t = won ? 'SIEG' : (lastResult && lastResult.winner === -1 ? 'REMIS' : 'K.O.');
      ctx.fillText(t, L.board + COLS * c / 2, H * 0.15);
    }
  }

  // ---------- Oberfläche ----------
  function showBanner(text, sub, withButton, color) {
    const b = $('#banner');
    b.hidden = false;
    b.classList.toggle('result', !!withButton);
    $('#bannerText').textContent = text;
    $('#bannerText').style.color = color || '';
    $('#bannerSub').textContent = sub || '';
    $('#btnNext').hidden = !withButton;
  }

  function hideBanner() {
    $('#banner').hidden = true;
  }

  function updateRounds() {
    $('#r0').textContent = rounds[0];
    $('#r1').textContent = rounds[1];
  }

  function updatePlayerUI() {
    for (let i = 0; i < 2; i++) {
      const s = slots[i];
      const sec = $('#p' + i);
      $('.name', sec).textContent = playerName(i);
      const dot = $('.dot', sec);
      dot.className = 'dot ' + (s.connected ? 'on' : s.clientId ? 'off' : s.kbd ? 'kbd' : '');
      dot.title = s.connected ? 'Handy verbunden' : s.clientId ? 'Handy getrennt' : 'Tastatur';
      const card = $('#card' + i);
      card.classList.toggle('joined', s.connected);
      $('.status', card).textContent = s.connected ? `✔ ${playerName(i)}` : 'Wartet …';
      $('.kick', card).hidden = !s.connected;
    }
    const n = slots.filter(s => s.connected).length;
    $('#startHint').textContent = n === 2
      ? 'Beide Spieler sind bereit!'
      : 'Ohne Handy kann ein Platz zum Testen per Tastatur gespielt werden (siehe Hilfe).';
  }

  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* nicht unterstützt */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && phase !== 'lobby') requestWakeLock();
  });

  document.querySelectorAll('.kick').forEach(btn => btn.addEventListener('click', () => {
    const s = slots[Number(btn.dataset.slot)];
    const c = s.conn;
    safeSend(c, { type: 'kicked' });
    s.conn = null; s.connected = false; s.clientId = null; s.name = '';
    setTimeout(() => { try { c && c.close(); } catch (e) { /* egal */ } }, 300);
    updatePlayerUI();
  }));

  $('#btnStart').addEventListener('click', e => { e.currentTarget.blur(); if (phase === 'lobby') startMatch(); });
  $('#btnNext').addEventListener('click', e => { e.currentTarget.blur(); if (phase === 'over') startRound(); });
  $('#btnPause').addEventListener('click', e => { e.currentTarget.blur(); togglePause(); });
  $('#btnLobby').addEventListener('click', e => { e.currentTarget.blur(); toLobby(); });
  $('#btnFull').addEventListener('click', e => {
    e.currentTarget.blur();
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });

  // ---------- Start ----------
  if (location.protocol === 'file:') $('#fileWarn').hidden = false;
  updatePlayerUI();
  resize();
  requestAnimationFrame(loop);
  let saved = null;
  try { saved = sessionStorage.getItem('tetrisRoom'); } catch (e) { /* egal */ }
  if (typeof Peer === 'undefined') setNet('PeerJS konnte nicht geladen werden.', 'err');
  else startPeer(saved || newCode(), 0);
})();
