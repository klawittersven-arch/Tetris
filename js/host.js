/*
 * Beamer-Ansicht: verwaltet die Verbindungen zu bis zu 30 Handys (PeerJS/WebRTC).
 * Runde 1: alle spielen auf dem Handy, der Beamer zeigt die Rangliste.
 * Runde 2: die zwei Schnellsten spielen das Finale-Duell am Beamer.
 */
(function () {
  'use strict';

  const { Game, COLS, VISIBLE } = window.Tetris;
  const { drawBoard, miniPiece } = window.TetrisRender;
  const PREFIX = 'tetris-duell-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const MAX_PLAYERS = 30;
  const DAS = 160;   // ms bis zur Wiederholung beim Gedrückthalten
  const ARR = 45;    // ms zwischen Wiederholungen
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
  // lobby | r1-countdown | r1 | r1-done | countdown | playing | paused | over
  let phase = 'lobby';
  let pausedFrom = '';
  let pauseReason = '';
  let target = 100;
  let r1Seed = 0;
  let qualified = [];           // clientIds in Reihenfolge des Erreichens
  let finalists = [null, null]; // clientIds der beiden Finalisten
  let games = [null, null];
  let rounds = [0, 0];
  let lastResult = null;        // { winner: 0|1|-1 }
  let countdownTimer = null;
  let boardDirty = true;
  const players = new Map();    // clientId -> Spieler
  const inputs = [0, 1].map(() => freshInput());
  const popups = [[], []];

  function freshInput() {
    return { left: false, right: false, dir: 0, das: 0, arr: 0 };
  }

  function finalist(i) {
    return players.get(finalists[i]) || null;
  }

  function finalistName(i) {
    const p = finalist(i);
    return p ? p.name : `Spieler ${i + 1}`;
  }

  function isDuel() {
    return ['countdown', 'playing', 'over'].includes(phase) || (phase === 'paused' && pausedFrom === 'playing');
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

  function joinUrl() {
    const u = new URL('controller.html', location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('room', roomCode);
    if (serverParam) u.searchParams.set('server', serverParam);
    return u.toString();
  }

  function makeQr(el, text) {
    el.innerHTML = '';
    if (typeof QRCode === 'undefined') { el.textContent = text; return; }
    new QRCode(el, { text, width: 512, height: 512, correctLevel: QRCode.CorrectLevel.M });
  }

  function renderJoinInfo() {
    makeQr($('#qrMain'), joinUrl());
    makeQr($('#qQr'), joinUrl());
    document.querySelectorAll('.roomcode').forEach(el => { el.textContent = roomCode; });
    const base = new URL('controller.html', location.href);
    $('#joinUrl').textContent = base.host + base.pathname;
  }

  function uniqueName(raw, id) {
    let base = String(raw || '').trim().slice(0, 16) || 'Spieler/in';
    const taken = n => [...players.values()].some(p => p.id !== id && p.name.toLowerCase() === n.toLowerCase());
    let name = base, k = 2;
    while (taken(name)) name = `${base.slice(0, 13)} ${k++}`;
    return name;
  }

  function handleConnection(conn) {
    let me = null;

    conn.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (me && me.conn === conn) me.lastSeen = Date.now();

      if (msg.type === 'hello') {
        const id = String(msg.clientId || Math.random());
        let p = players.get(id);
        if (!p) {
          if (players.size >= MAX_PLAYERS) {
            safeSend(conn, { type: 'full' });
            setTimeout(() => conn.close(), 500);
            return;
          }
          p = { id, conn: null, name: '', connected: false, score: 0, lines: 0, qualifiedAt: 0, lastSeen: 0, bumped: 0 };
          players.set(id, p);
        } else if (p.conn && p.conn !== conn) {
          try { p.conn.close(); } catch (e) { /* egal */ }
        }
        me = p;
        p.conn = conn;
        p.connected = true;
        p.lastSeen = Date.now();
        p.name = uniqueName(msg.name, id);
        // Das Handy meldet seinen aktuellen Punktestand (0 nach Neuladen der Seite)
        if (!p.qualifiedAt) {
          p.score = phase === 'lobby' ? 0 : Math.max(0, Number(msg.score) || 0);
          p.lines = phase === 'lobby' ? 0 : Math.max(0, Number(msg.lines) || 0);
        }
        safeSend(conn, { type: 'welcome', name: p.name });
        sendState(p);
        boardDirty = true;
        updateLobby();
        updateDots();
        if (phase === 'paused' && pauseReason === 'disconnect' && finalistsConnected()) resume();
      } else if (!me || me.conn !== conn) {
        return;
      } else if (msg.type === 'input') {
        const i = finalists.indexOf(me.id);
        if (i >= 0 && isDuel()) handleInput(i, msg.a, !!msg.d);
      } else if (msg.type === 'score') {
        if (phase !== 'r1' || me.qualifiedAt) return;
        const score = Math.max(0, Number(msg.score) || 0);
        if (score > me.score) me.bumped = performance.now();
        me.score = score;
        me.lines = Math.max(0, Number(msg.lines) || 0);
        boardDirty = true;
        if (me.score >= target) qualify(me);
      } else if (msg.type === 'reset') {
        if (phase !== 'r1' || me.qualifiedAt) return;
        me.score = 0;
        me.lines = 0;
        boardDirty = true;
      } else if (msg.type === 'ping') {
        safeSend(conn, { type: 'pong', t: msg.t });
      }
    });

    conn.on('close', () => { if (me) dropPlayer(me, conn); });
    conn.on('error', e => console.warn('Verbindungsfehler', e));
  }

  // Verbindung eines Spielers als getrennt markieren
  function dropPlayer(p, conn) {
    if (p.conn !== conn) return;
    p.connected = false;
    p.conn = null;
    const i = finalists.indexOf(p.id);
    if (i >= 0) {
      inputs[i] = freshInput();
      if (games[i]) games[i].softDrop = false;
      if (phase === 'playing' || phase === 'countdown') pause('disconnect');
    }
    if (phase === 'lobby') players.delete(p.id);
    boardDirty = true;
    updateLobby();
    updateDots();
    try { conn.close(); } catch (e) { /* egal */ }
  }

  // Handys senden jede Sekunde ein Ping – bleibt es aus, gilt das Handy als getrennt
  setInterval(() => {
    for (const p of players.values()) {
      if (p.connected && Date.now() - p.lastSeen > 5000) dropPlayer(p, p.conn);
    }
  }, 1000);

  function finalistsConnected() {
    return [0, 1].every(i => { const p = finalist(i); return !p || p.connected; });
  }

  function safeSend(conn, msg) {
    try { if (conn && conn.open) conn.send(msg); } catch (e) { /* egal */ }
  }

  function sendState(p, extra) {
    if (!p || !p.connected) return;
    const slot = finalists.indexOf(p.id);
    let result = null;
    if (phase === 'over' && lastResult && slot >= 0) {
      result = lastResult.winner === -1 ? 'draw' : (lastResult.winner === slot ? 'win' : 'lose');
    }
    const g = slot >= 0 ? games[slot] : null;
    safeSend(p.conn, Object.assign({
      type: 'state', phase, pausedFrom, pauseReason, target, seed: r1Seed,
      name: p.name, players: players.size,
      qualified: !!p.qualifiedAt, slot,
      finalists: [finalistName(0), finalistName(1)],
      color: slot >= 0 ? PLAYER_COLORS[slot] : null,
      rounds: slot >= 0 ? [rounds[slot], rounds[1 - slot]] : rounds,
      result, duelScore: g ? g.score : 0,
    }, extra || {}));
  }

  function broadcastState(extra) {
    for (const p of players.values()) sendState(p, extra);
  }

  // ---------- Runde 1 ----------
  function connectedCount() {
    return [...players.values()].filter(p => p.connected).length;
  }

  function startR1() {
    if (phase !== 'lobby' || connectedCount() < 2) return;
    target = Math.max(100, Math.min(100000, Math.round(Number($('#target').value) || 100)));
    $('#target').value = target;
    document.querySelectorAll('.target').forEach(el => { el.textContent = target.toLocaleString('de-DE'); });
    r1Seed = (Math.random() * 2 ** 32) >>> 0;
    qualified = [];
    finalists = [null, null];
    for (const p of players.values()) { p.score = 0; p.lines = 0; p.qualifiedAt = 0; }
    show('quali');
    boardDirty = true;
    requestWakeLock();
    countdown('r1-countdown', () => { phase = 'r1'; broadcastState(); });
  }

  function qualify(p) {
    p.qualifiedAt = qualified.length + 1;
    qualified.push(p.id);
    sendState(p);
    boardDirty = true;
    if (qualified.length >= 2) endR1();
  }

  function endR1() {
    phase = 'r1-done';
    finalists = [qualified[0], qualified[1]];
    rounds = [0, 0];
    renderBoard();
    $('#f0').textContent = finalistName(0);
    $('#f1').textContent = finalistName(1);
    setTimeout(() => { if (phase === 'r1-done') $('#finalists').hidden = false; }, 1200);
    broadcastState();
  }

  function renderBoard() {
    boardDirty = false;
    const list = [...players.values()].sort((a, b) => {
      if (a.qualifiedAt || b.qualifiedAt) return (a.qualifiedAt || 99) - (b.qualifiedAt || 99);
      return b.score - a.score || a.name.localeCompare(b.name);
    });
    const n = Math.max(list.length, 1);
    const cols = n <= 10 ? 1 : n <= 20 ? 2 : 3;
    const rows = Math.max(Math.ceil(n / cols), 6);
    const ol = $('#board');
    ol.style.setProperty('--cols', cols);
    ol.style.setProperty('--rows', rows);
    ol.style.setProperty('--fs', `${Math.min(5, 34 / rows)}vh`);
    const now = performance.now();
    ol.innerHTML = '';
    list.forEach((p, k) => {
      const li = document.createElement('li');
      if (p.qualifiedAt) li.classList.add('q');
      if (!p.connected) li.classList.add('off');
      if (now - p.bumped < 500) li.classList.add('bump');
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.width = `${Math.min(100, (p.score / target) * 100)}%`;
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = p.qualifiedAt ? ['🥇', '🥈'][p.qualifiedAt - 1] || '✔' : `${k + 1}.`;
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = p.name;
      const pts = document.createElement('span');
      pts.className = 'pts';
      pts.textContent = p.score.toLocaleString('de-DE');
      li.append(bar, rank, nm, pts);
      ol.append(li);
    });
    $('#qPlayers').textContent = connectedCount();
  }

  // ---------- Runde 2: Duell ----------
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
    if (!down || !active) return;
    if (action === 'cw') g.rotate(1);
    else if (action === 'drop') g.hardDrop();
  }

  function updateAutoRepeat(i, dt) {
    const inp = inputs[i];
    const g = games[i];
    if (!inp.dir) return;
    inp.das += dt;
    if (inp.das < DAS) return;
    inp.arr += dt;
    while (inp.arr >= ARR) {
      inp.arr -= ARR;
      if (!g.move(inp.dir)) { inp.arr = 0; break; }
    }
  }

  function startFinal() {
    if (phase !== 'r1-done') return;
    rounds = [0, 0];
    startDuelRound();
  }

  function startDuelRound() {
    const seed = (Math.random() * 2 ** 32) >>> 0;
    games = [new Game(seed, seed ^ 0x1234567), new Game(seed, seed ^ 0x7654321)];
    inputs[0] = freshInput();
    inputs[1] = freshInput();
    popups[0] = []; popups[1] = [];
    lastResult = null;
    show('game');
    updateDots();
    updateRounds();
    requestWakeLock();
    countdown('countdown', () => {
      phase = 'playing';
      broadcastState();
      if (!finalistsConnected()) pause('disconnect');
    });
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
    const sub = `Stand ${rounds[0]} : ${rounds[1]}`;
    if (winner >= 0) showBanner(`${finalistName(winner)} gewinnt!`, sub, true, PLAYER_COLORS[winner]);
    else showBanner('Unentschieden!', sub, true);
    broadcastState();
  }

  function handleEvents(i) {
    const g = games[i];
    const p = finalist(i);
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
        if (p) safeSend(p.conn, { type: 'fx', k: 'clear', n: ev.lines });
      } else if (ev.type === 'garbage') {
        if (p) safeSend(p.conn, { type: 'fx', k: 'hit', n: ev.lines });
      } else if (ev.type === 'lock') {
        if (p) safeSend(p.conn, { type: 'score', score: g.score, lines: g.lines, level: g.level });
      }
    }
  }

  function addPopup(i, text, color) {
    popups[i].push({ text, color, t: 0 });
    if (popups[i].length > 4) popups[i].shift();
  }

  // ---------- Ablauf: Countdown, Pause, Lobby ----------
  function countdown(cdPhase, done) {
    clearTimeout(countdownTimer);
    phase = cdPhase;
    let n = 3;
    const tick = () => {
      if (phase !== cdPhase) return;
      if (n > 0) {
        showBanner(String(n), cdPhase === 'r1-countdown' ? 'Runde 1 – alle aufs Handy schauen!' : '', false);
        broadcastState({ count: n });
        n--;
        countdownTimer = setTimeout(tick, 900);
      } else {
        showBanner('LOS!', '', false);
        done();
        countdownTimer = setTimeout(() => { if (phase === 'playing' || phase === 'r1') hideBanner(); }, 600);
      }
    };
    tick();
  }

  function pause(reason) {
    let from;
    if (phase === 'r1' || phase === 'r1-countdown') from = 'r1';
    else if (phase === 'playing' || phase === 'countdown') from = 'playing';
    else return;
    clearTimeout(countdownTimer);
    pausedFrom = from;
    phase = 'paused';
    pauseReason = reason || 'teacher';
    for (const g of games) if (g) g.softDrop = false;
    const sub = reason === 'disconnect'
      ? 'Ein Handy hat die Verbindung verloren – bitte die Seite am Handy neu laden oder den QR-Code erneut scannen.'
      : 'Weiter mit P';
    showBanner('PAUSE', sub, false);
    broadcastState();
  }

  function resume() {
    if (phase !== 'paused') return;
    const to = pausedFrom;
    pauseReason = '';
    countdown(to === 'r1' ? 'r1-countdown' : 'countdown', () => {
      phase = to;
      pausedFrom = '';
      broadcastState();
    });
  }

  function togglePause() {
    if (phase === 'paused') resume();
    else pause('teacher');
  }

  function toLobby() {
    clearTimeout(countdownTimer);
    phase = 'lobby';
    pausedFrom = '';
    pauseReason = '';
    games = [null, null];
    rounds = [0, 0];
    qualified = [];
    finalists = [null, null];
    for (const [id, p] of players) {
      if (!p.connected) players.delete(id);
      else { p.score = 0; p.lines = 0; p.qualifiedAt = 0; }
    }
    show('lobby');
    updateLobby();
    updateRounds();
    broadcastState();
  }

  function confirmLobby() {
    if (phase === 'lobby') return;
    if (phase === 'over' || phase === 'r1-done' || confirm('Spiel abbrechen und zurück zur Lobby?')) toLobby();
  }

  // ---------- Tastatur ----------
  const KEYMAP = {
    KeyA: [0, 'left'], KeyD: [0, 'right'], KeyW: [0, 'cw'], KeyS: [0, 'drop'],
    ArrowLeft: [1, 'left'], ArrowRight: [1, 'right'], ArrowUp: [1, 'cw'], ArrowDown: [1, 'drop'],
  };

  document.addEventListener('keydown', e => {
    if (e.target && e.target.tagName === 'INPUT') {
      if (e.key === 'Enter') { e.target.blur(); startR1(); }
      return;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      if (phase === 'lobby') startR1();
      else if (phase === 'r1-done') startFinal();
      else if (phase === 'over') startDuelRound();
      return;
    }
    if (e.code === 'KeyP') { togglePause(); return; }
    if (e.code === 'Escape') { confirmLobby(); return; }
    const m = KEYMAP[e.code];
    if (!m || !isDuel()) return;
    e.preventDefault();
    if (e.repeat) return;
    handleInput(m[0], m[1], true);
  });
  document.addEventListener('keyup', e => {
    const m = KEYMAP[e.code];
    if (m && isDuel()) handleInput(m[0], m[1], false);
  });

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
    if (isDuel()) {
      for (let i = 0; i < 2; i++) {
        popups[i].forEach(p => { p.t += dt; });
        popups[i] = popups[i].filter(p => p.t < 1400);
        drawPlayer(i);
      }
    }
    if (boardDirty && !$('#quali').hidden) renderBoard();
    requestAnimationFrame(loop);
  }

  // ---------- Darstellung Duell ----------
  const canvases = [$('#p0 canvas'), $('#p1 canvas')];
  const ctxs = canvases.map(c => c.getContext('2d'));
  const SIDE = 5, GAP1 = 0.4, METER = 0.6, GAP2 = 0.25;
  const TOTAL_W = SIDE + GAP1 + METER + GAP2 + COLS;
  let cell = 30;

  function resize() {
    const header = Math.max(40, $('.pname').getBoundingClientRect().height) + innerHeight * 0.04;
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

  function drawPlayer(i) {
    const ctx = ctxs[i];
    const c = cell;
    const W = TOTAL_W * c, H = VISIBLE * c;
    const L = layout(i);
    const g = games[i];
    ctx.clearRect(0, 0, W, H);

    drawBoard(ctx, g, L.board, 0, c);
    ctx.strokeStyle = PLAYER_COLORS[i];
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

    label('NÄCHSTE', 0.45);
    ctx.fillStyle = '#0d1424';
    ctx.fillRect(sx, 0.9 * c, sw, 8.6 * c);
    ctx.strokeStyle = '#24304d';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx + 1, 0.9 * c + 1, sw - 2, 8.6 * c - 2);
    if (g) {
      g.nextPieces(3).forEach((t, k) => {
        miniPiece(ctx, t, sx + sw / 2, (2.35 + k * 2.7) * c, c * (k === 0 ? 0.8 : 0.65));
      });
    }

    label('PUNKTE', 11.3);
    value(g ? g.score.toLocaleString('de-DE') : '0', 12.25);
    label('REIHEN', 13.55);
    value(g ? String(g.lines) : '0', 14.5);
    label('LEVEL', 15.8);
    value(g ? String(g.level) : '1', 16.75);

    // Einblendungen (TETRIS!, Combo, Angriff)
    popups[i].forEach((p, k) => {
      ctx.globalAlpha = Math.max(0, 1 - p.t / 1400);
      ctx.fillStyle = p.color;
      ctx.font = `900 ${Math.round(c * 1.1)}px "Segoe UI", system-ui, sans-serif`;
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 8;
      ctx.fillText(p.text, L.board + COLS * c / 2, (7 + k * 1.4) * c - p.t / 1400 * c);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    });

    // Ergebnis auf dem Feld
    if (g && phase === 'over' && lastResult) {
      const won = lastResult.winner === i;
      const draw = lastResult.winner === -1;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(L.board, H * 0.15 - 1.6 * c, COLS * c, 3.2 * c);
      ctx.fillStyle = won ? '#2ecc71' : (draw ? '#e8ecf8' : '#ff4d5e');
      ctx.font = `900 ${Math.round(c * 1.6)}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(won ? 'SIEG' : (draw ? 'REMIS' : 'K.O.'), L.board + COLS * c / 2, H * 0.15);
    }
  }

  // ---------- Oberfläche ----------
  function show(view) {
    $('#lobby').hidden = view !== 'lobby';
    $('#quali').hidden = view !== 'quali';
    $('#game').hidden = view !== 'game';
    $('#finalists').hidden = true;
    hideBanner();
    if (view === 'game') resize();
  }

  function showBanner(text, sub, withButtons, color) {
    const b = $('#banner');
    b.hidden = false;
    b.classList.toggle('result', !!withButtons);
    $('#bannerText').textContent = text;
    $('#bannerText').style.color = color || '';
    $('#bannerSub').textContent = sub || '';
    $('#resultButtons').hidden = !withButtons;
  }

  function hideBanner() {
    $('#banner').hidden = true;
  }

  function updateRounds() {
    $('#r0').textContent = rounds[0];
    $('#r1').textContent = rounds[1];
  }

  function updateDots() {
    for (let i = 0; i < 2; i++) {
      const p = finalist(i);
      const sec = $('#p' + i);
      $('.name', sec).textContent = finalistName(i);
      const dot = $('.dot', sec);
      dot.className = 'dot ' + (p ? (p.connected ? 'on' : 'off') : 'kbd');
      dot.title = p ? (p.connected ? 'Handy verbunden' : 'Handy getrennt') : 'Tastatur';
    }
  }

  function updateLobby() {
    const ul = $('#chips');
    ul.innerHTML = '';
    const list = [...players.values()];
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Noch niemand – scannt den QR-Code!';
      ul.append(li);
    }
    for (const p of list) {
      const li = document.createElement('li');
      li.textContent = p.name;
      if (!p.connected) li.classList.add('off');
      li.title = 'Antippen zum Entfernen';
      li.addEventListener('click', () => kick(p));
      ul.append(li);
    }
    const n = connectedCount();
    $('#count').textContent = n;
    $('#btnStart').disabled = n < 2;
    $('#startHint').textContent = n < 2 ? 'Mindestens 2 Spieler/innen nötig.' : 'Startet, sobald genug dabei sind.';
  }

  function kick(p) {
    if (phase !== 'lobby') return;
    const c = p.conn;
    safeSend(c, { type: 'kicked' });
    players.delete(p.id);
    setTimeout(() => { try { c && c.close(); } catch (e) { /* egal */ } }, 300);
    updateLobby();
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

  const onClick = (sel, fn) => document.querySelectorAll(sel).forEach(el => el.addEventListener('click', e => {
    e.currentTarget.blur();
    fn();
  }));
  onClick('#btnStart', startR1);
  onClick('#btnFinal', startFinal);
  onClick('#btnBackQ', toLobby);
  onClick('#btnNext', () => { if (phase === 'over') startDuelRound(); });
  onClick('#btnNew', toLobby);
  onClick('#btnPause, #btnPauseQ', togglePause);
  onClick('#btnLobby, #btnLobbyQ', confirmLobby);
  onClick('.btnFull', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });

  // ---------- Start ----------
  if (location.protocol === 'file:') $('#fileWarn').hidden = false;
  updateLobby();
  requestAnimationFrame(loop);
  let saved = null;
  try { saved = sessionStorage.getItem('tetrisRoom'); } catch (e) { /* egal */ }
  if (typeof Peer === 'undefined') setNet('PeerJS konnte nicht geladen werden.', 'err');
  else startPeer(saved || newCode(), 0);
})();
