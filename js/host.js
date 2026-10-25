/*
 * Beamer-Ansicht: verwaltet die Verbindungen zu bis zu 30 Handys (über den eigenen Cloudflare-Dienst).
 * Runde 1: alle spielen auf dem Handy, der Beamer zeigt die Rangliste.
 * Runde 2: die 2 oder 4 Schnellsten spielen das Finale am Beamer.
 */
(function () {
  'use strict';

  const { Game, COLS, VISIBLE } = window.Tetris;
  const { drawBoard, miniPiece } = window.TetrisRender;
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const MAX_PLAYERS = 30;
  const DAS = 160;   // ms bis zur Wiederholung beim Gedrückthalten
  const ARR = 45;    // ms zwischen Wiederholungen
  const PLAYER_COLORS = ['#3da5ff', '#ff9f1c', '#34d399', '#f472b6'];
  const DROP_AFTER = 20000; // ms: danach kann ohne getrennte Finalisten weitergespielt werden

  const $ = (s, el = document) => el.querySelector(s);

  const PING_TIMEOUT = 9000; // ms ohne Lebenszeichen, bis ein Handy als getrennt gilt

  // ---------- Zustand ----------
  let net = null;             // Verbindung zum Cloudflare-Dienst
  let roomCode = null;
  // lobby | r1-countdown | r1 | r1-done | countdown | playing | paused | over
  let phase = 'lobby';
  let pausedFrom = '';
  let pauseReason = '';
  let target = 100;
  let r1Seed = 0;
  let qualified = [];           // clientIds in Reihenfolge des Erreichens
  let finalSize = 2;            // 2 oder 4 Finalisten (Lobby)
  let N = 2;                    // Finalisten der laufenden Partie
  let finalists = [];           // clientIds der Finalisten
  let games = [];
  let rounds = [];              // Siege pro Finalist
  let places = [];              // 0 = noch im Spiel, sonst Platzierung
  let nextTarget = [];          // Müll reihum: nächster Gegner pro Spieler
  let lastResult = null;        // { winner: Index | -1 }
  let dropTimer = null;
  let countdownTimer = null;
  let boardDirty = true;
  const players = new Map();    // clientId -> Spieler
  let inputs = [];
  let popups = [];

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

  function startNet(code) {
    roomCode = code;
    try { sessionStorage.setItem('tetrisRoom', code); } catch (e) { /* egal */ }
    if (net) net.close();
    setNet('Verbinde mit dem Server …');
    let first = true;
    net = TetrisNet.host(code, {
      onOpen() {
        setNet('Bereit – Handys können beitreten.', 'ok');
        if (first) renderJoinInfo();
        first = false;
        // Nach Neuladen der Seite: alle Handys im Raum melden sich neu an
        net.broadcast({ type: 'rehello' });
      },
      onStatus(st) {
        if (st === 'reconnecting') setNet('Verbindung zum Server unterbrochen – verbinde neu …', 'err');
        if (st === 'replaced') setNet('Dieser Raum wurde in einem anderen Fenster geöffnet. Bitte nur ein Beamer-Fenster benutzen.', 'err');
      },
      onMessage(msg) {
        if (msg.from) handleMessage(String(msg.from).slice(0, 64), msg);
      },
    });
  }

  // „Verbindung“ zu einem Handy: schickt Nachrichten an dessen eigenes Topic
  function makeConn(id) {
    return { id, open: true, send(msg) { if (net) net.sendTo(id, msg); }, close() { this.open = false; } };
  }

  function newRoom() {
    if (phase !== 'lobby') return;
    net.broadcast({ type: 'closed' });
    players.clear();
    updateLobby();
    // kurz warten, damit die Nachricht an die Handys noch rausgeht
    setTimeout(() => startNet(newCode()), 500);
  }

  function joinUrl(rejoinToken) {
    const u = new URL('controller.html', location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('room', roomCode);
    if (rejoinToken) u.searchParams.set('rejoin', rejoinToken);
    return u.toString();
  }

  function newToken() {
    let t = '';
    for (let i = 0; i < 8; i++) t += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return t;
  }

  // Ein neues Handy übernimmt eine getrennte Person (Wiedereinstieg per persönlichem QR-Code)
  function rekey(p, newId) {
    const oldId = p.id;
    players.delete(oldId);
    p.id = newId;
    players.set(newId, p);
    finalists = finalists.map(x => (x === oldId ? newId : x));
    qualified = qualified.map(x => (x === oldId ? newId : x));
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

  function handleMessage(id, msg) {
    let me = players.get(id);
    if (me && me.connected) me.lastSeen = Date.now();

    if (msg.type === 'hello') {
      const conn = makeConn(id);
      let rejoined = false;
      if (!me && msg.rejoin) {
        const old = [...players.values()].find(q => q.token === String(msg.rejoin) && !q.connected);
        if (old) { rekey(old, id); me = old; rejoined = true; }
      }
      let p = me;
      if (!p) {
        if (players.size >= MAX_PLAYERS) { safeSend(conn, { type: 'full' }); return; }
        p = { id, conn: null, name: '', connected: false, score: 0, lines: 0, qualifiedAt: 0, lastSeen: 0, bumped: 0, token: newToken() };
        players.set(id, p);
      } else if (p.conn) {
        p.conn.close();
      }
      p.conn = conn;
      p.connected = true;
      p.lastSeen = Date.now();
      if (!rejoined && (String(msg.name || '').trim() || !p.name)) p.name = uniqueName(msg.name, id);
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
      if (phase === 'paused' && pauseReason === 'disconnect') {
        if (finalistsConnected()) resume();
        else renderRejoin();
      }
      return;
    }
    if (!me || !me.connected) {
      // Unbekanntes Handy (z. B. nach Neuladen der Beamer-Seite): neu anmelden lassen
      if (msg.type !== 'bye' && net) net.sendTo(id, { type: 'rehello' });
      return;
    }
    if (msg.type === 'input') {
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
      safeSend(me.conn, { type: 'pong', t: msg.t });
    } else if (msg.type === 'bye') {
      dropPlayer(me, me.conn);
    }
  }

  // Verbindung eines Spielers als getrennt markieren
  function dropPlayer(p, conn) {
    if (p.conn !== conn) return;
    p.connected = false;
    p.conn = null;
    const i = finalists.indexOf(p.id);
    if (i >= 0 && !places[i]) {
      if (inputs[i]) inputs[i] = freshInput();
      if (games[i]) games[i].softDrop = false;
      if (phase === 'playing' || phase === 'countdown') pause('disconnect');
      else if (phase === 'paused' && pausedFrom === 'playing') { pauseReason = 'disconnect'; renderRejoin(); broadcastState(); }
    }
    if (phase === 'lobby') players.delete(p.id);
    boardDirty = true;
    updateLobby();
    updateDots();
    if (conn) conn.close();
  }

  // Handys senden alle 2 Sekunden ein Ping – bleibt es aus, gilt das Handy als getrennt
  setInterval(() => {
    for (const p of players.values()) {
      if (p.connected && Date.now() - p.lastSeen > PING_TIMEOUT) dropPlayer(p, p.conn);
    }
  }, 1000);

  function finalistsConnected() {
    return finalists.every((id, i) => { const p = finalist(i); return places[i] || !p || p.connected; });
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
    const names = finalists.map((id, i) => finalistName(i));
    safeSend(p.conn, Object.assign({
      type: 'state', phase, pausedFrom, pauseReason, target, seed: r1Seed,
      name: p.name, players: players.size,
      qualified: !!p.qualifiedAt, slot,
      finalists: names, wins: rounds, finalSize,
      color: slot >= 0 ? PLAYER_COLORS[slot] : null,
      place: slot >= 0 ? places[slot] || 0 : 0,
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
    if (phase !== 'lobby' || connectedCount() < Math.max(2, finalSize)) return;
    target = Math.max(100, Math.min(100000, Math.round(Number($('#target').value) || 100)));
    $('#target').value = target;
    document.querySelectorAll('.target').forEach(el => { el.textContent = target.toLocaleString('de-DE'); });
    document.querySelectorAll('.fsize').forEach(el => { el.textContent = finalSize; });
    r1Seed = (Math.random() * 2 ** 32) >>> 0;
    qualified = [];
    finalists = [];
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
    if (qualified.length >= finalSize) endR1();
  }

  function endR1() {
    phase = 'r1-done';
    N = finalSize;
    finalists = qualified.slice(0, N);
    rounds = finalists.map(() => 0);
    places = [];
    renderBoard();
    renderVersus();
    setTimeout(() => { if (phase === 'r1-done') $('#finalists').hidden = false; }, 1200);
    broadcastState();
  }

  function renderBoard() {
    boardDirty = false;
    const list = [...players.values()].sort((a, b) => {
      if (a.qualifiedAt || b.qualifiedAt) return (a.qualifiedAt || 99) - (b.qualifiedAt || 99);
      return b.score - a.score || a.name.localeCompare(b.name, 'de', { numeric: true });
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
      rank.textContent = p.qualifiedAt ? ['🥇', '🥈', '🥉', '🏅'][p.qualifiedAt - 1] || '✔' : `${k + 1}.`;
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
    rounds = finalists.map(() => 0);
    buildFields();
    startDuelRound();
  }

  function startDuelRound() {
    const seed = (Math.random() * 2 ** 32) >>> 0;
    games = finalists.map((id, i) => new Game(seed, (seed ^ (0x1234567 * (i + 1))) >>> 0));
    inputs = finalists.map(() => freshInput());
    popups = finalists.map(() => []);
    places = finalists.map(() => 0);
    nextTarget = finalists.map((id, i) => (i + 1) % N);
    lastResult = null;
    clearTimeout(dropTimer);
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

  function aliveCount() {
    return places.filter(pl => !pl).length;
  }

  // Ausgeschiedene Felder bekommen ihren Platz; bleibt höchstens einer übrig, ist die Runde vorbei
  function checkEliminations() {
    const out = [];
    games.forEach((g, i) => { if (g.over && !places[i]) out.push(i); });
    if (!out.length) return;
    const aliveBefore = aliveCount();
    const place = aliveBefore - out.length + 1;   // gleichzeitig Ausgeschiedene teilen sich den Platz
    for (const i of out) {
      places[i] = place;
      inputs[i] = freshInput();
      sendState(finalist(i));
    }
    if (aliveCount() <= 1) finishRound();
  }

  function finishRound() {
    let winner = places.findIndex(pl => !pl);
    if (winner >= 0) places[winner] = 1;
    else winner = -1;                              // alle gleichzeitig raus → unentschieden
    if (winner >= 0) rounds[winner]++;
    lastResult = { winner };
    phase = 'over';
    clearTimeout(dropTimer);
    updateRounds();
    const sub = standText();
    if (winner >= 0) showBanner(`${finalistName(winner)} gewinnt!`, sub, true, PLAYER_COLORS[winner]);
    else showBanner('Unentschieden!', sub, true);
    broadcastState();
  }

  function standText() {
    if (N === 2) return `Stand ${rounds[0]} : ${rounds[1]}`;
    return 'Siege: ' + finalists.map((id, i) => `${finalistName(i)} ${rounds[i]}`).join(' · ');
  }

  // Müll reihum an den nächsten noch lebenden Gegner
  function pickTarget(i) {
    let j = nextTarget[i];
    for (let k = 0; k < N; k++) {
      if (j !== i && !places[j] && !games[j].over) {
        nextTarget[i] = (j + 1) % N;
        return j;
      }
      j = (j + 1) % N;
    }
    return -1;
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
          const t = pickTarget(i);
          if (t >= 0) {
            games[t].receiveGarbage(ev.attack);
            addPopup(i, N > 2 ? `+${ev.attack} ➜ ${finalistName(t)}` : `+${ev.attack} ➜`, '#ff4d5e');
          }
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
    showBanner('PAUSE', reason === 'disconnect' ? '' : 'Weiter mit P', false);
    if (reason === 'disconnect') renderRejoin();
    clearTimeout(dropTimer);
    if (reason === 'disconnect' && from === 'playing') dropTimer = setTimeout(showDropButtons, DROP_AFTER);
    broadcastState();
  }

  // Persönliche QR-Codes für alle getrennten Finalisten im Pausen-Banner
  function renderRejoin() {
    const box = $('#rejoin');
    box.innerHTML = '';
    const missing = finalists.map((id, i) => i).filter(i => !places[i] && !(finalist(i) && finalist(i).connected));
    for (const i of missing) {
      const p = finalist(i);
      if (!p) continue;
      const card = document.createElement('div');
      card.className = 'rcard';
      card.style.setProperty('--pc', PLAYER_COLORS[i]);
      card.innerHTML = '<div class="rname"></div><div class="rtext"></div><div class="qr"></div><div class="rhint">oder auf deinem Handy einfach die Seite neu laden</div>';
      $('.rname', card).textContent = p.name;
      $('.rtext', card).textContent = `${p.name}, scanne diesen Code, um weiterzuspielen`;
      box.append(card);
      makeQr($('.qr', card), joinUrl(p.token));
    }
    box.hidden = !box.children.length;
    $('#banner').classList.toggle('rejoining', !box.hidden);
    const names = missing.map(i => finalistName(i));
    $('#bannerSub').textContent = names.length
      ? `Verbindung verloren – das Finale geht weiter, sobald ${names.join(' und ')} wieder da ${names.length > 1 ? 'sind' : 'ist'}.`
      : '';
    if (!$('#dropButtons').hidden) showDropButtons();
  }

  // Nach 20 s: „Ohne <Name> weiterspielen“ für jede getrennte Person im Finale
  function showDropButtons() {
    if (phase !== 'paused' || pauseReason !== 'disconnect') return;
    const box = $('#dropButtons');
    box.innerHTML = '';
    finalists.forEach((id, i) => {
      const p = finalist(i);
      if (places[i] || (p && p.connected)) return;
      const btn = document.createElement('button');
      btn.className = 'big alt';
      btn.textContent = `Ohne ${finalistName(i)} weiterspielen`;
      btn.addEventListener('click', () => dropFinalist(i));
      box.append(btn);
    });
    box.hidden = !box.children.length;
  }

  function dropFinalist(i) {
    if (!games[i] || places[i]) return;
    games[i].topOut();
    games[i].takeEvents();
    $('#dropButtons').hidden = true;
    checkEliminations();
    if (phase === 'paused' && finalistsConnected()) resume();
  }

  function resume() {
    if (phase !== 'paused') return;
    clearTimeout(dropTimer);
    $('#dropButtons').hidden = true;
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
    games = [];
    rounds = [];
    places = [];
    qualified = [];
    finalists = [];
    clearTimeout(dropTimer);
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
      for (let i = 0; i < N; i++) {
        if (places[i]) continue;
        updateAutoRepeat(i, dt);
        games[i].update(dt);
      }
      for (let i = 0; i < N; i++) handleEvents(i);
      checkEliminations();
    }
    if (isDuel()) {
      for (let i = 0; i < games.length; i++) {
        popups[i].forEach(p => { p.t += dt; });
        popups[i] = popups[i].filter(p => p.t < 1400);
        drawPlayer(i);
      }
    }
    if (boardDirty && !$('#quali').hidden) renderBoard();
    requestAnimationFrame(loop);
  }

  // ---------- Darstellung Duell ----------
  let canvases = [];
  let ctxs = [];
  const SIDE = 5, SIDE4 = 3.2, GAP1 = 0.4, METER = 0.6, GAP2 = 0.25;
  const sideW = () => (N > 2 ? SIDE4 : SIDE);
  const totalW = () => sideW() + GAP1 + METER + GAP2 + COLS;
  let cell = 30;

  // Spielerspalten für 2 oder 4 Finalisten anlegen
  function buildFields() {
    const game = $('#game');
    game.querySelectorAll('.player').forEach(el => el.remove());
    game.classList.toggle('four', N > 2);
    canvases = [];
    for (let i = 0; i < N; i++) {
      const sec = document.createElement('section');
      sec.className = 'player';
      sec.id = 'p' + i;
      sec.style.setProperty('--pc', PLAYER_COLORS[i]);
      sec.innerHTML = '<header class="pname"><span class="dot"></span><span class="name"></span></header><canvas class="board"></canvas>';
      game.append(sec);
      canvases.push($('canvas', sec));
    }
    ctxs = canvases.map(c => c.getContext('2d'));
    $('#center h1').style.background = N > 2
      ? 'linear-gradient(90deg, #3da5ff, #34d399, #f472b6, #ff9f1c)'
      : '';
    if (N > 2) { $('#center h1').style.webkitBackgroundClip = 'text'; $('#center h1').style.backgroundClip = 'text'; }
    updateDots();
    updateRounds();
  }

  function resize() {
    if (!canvases.length) return;
    const nameH = Math.max(30, $('#game .pname') ? $('#game .pname').getBoundingClientRect().height : 40);
    const TW = totalW();
    let byH, byW;
    if (N > 2) {
      const bar = $('#center').getBoundingClientRect().height;
      byH = (innerHeight - bar - nameH - innerHeight * 0.07) / VISIBLE;
      byW = (innerWidth * 0.95 - innerWidth * 0.014 * (N - 1)) / N / TW;
    } else {
      byH = (innerHeight - nameH - innerHeight * 0.04) / VISIBLE;
      byW = (innerWidth * 0.82 - Math.max(150, innerWidth * 0.15)) / 2 / TW;
    }
    cell = Math.max(8, Math.floor(Math.min(byH, byW)));
    const dpr = window.devicePixelRatio || 1;
    canvases.forEach((c, i) => {
      c.style.width = `${TW * cell}px`;
      c.style.height = `${VISIBLE * cell}px`;
      c.width = Math.round(TW * cell * dpr);
      c.height = Math.round(VISIBLE * cell * dpr);
      ctxs[i].setTransform(dpr, 0, 0, dpr, 0, 0);
    });
  }
  window.addEventListener('resize', resize);

  function layout(i) {
    const SW = sideW();
    // Bei 2: Spieler 1 Seitenleiste links, Spieler 2 rechts (gespiegelt). Bei 4: immer rechts.
    if (i === 0 && N === 2) {
      return { side: 0, meter: (SW + GAP1) * cell, board: (SW + GAP1 + METER + GAP2) * cell };
    }
    return { board: 0, meter: (COLS + GAP2) * cell, side: (COLS + GAP2 + METER + GAP1) * cell };
  }

  function drawPlayer(i) {
    const ctx = ctxs[i];
    const c = cell;
    const W = totalW() * c, H = VISIBLE * c;
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
    const sx = L.side, sw = sideW() * c;
    const compact = N > 2;
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

    if (compact) {
      // schmale Leiste: nächster Stein + Punkte
      label('NÄCHSTE', 0.45);
      ctx.fillStyle = '#0d1424';
      ctx.fillRect(sx, 0.9 * c, sw, 3.2 * c);
      if (g) miniPiece(ctx, g.nextPieces(1)[0], sx + sw / 2, 2.5 * c, c * 0.62);
      label('PUNKTE', 5.2);
      ctx.save();
      ctx.font = `800 ${Math.round(c * 0.8)}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillStyle = '#e8ecf8';
      ctx.fillText(g ? g.score.toLocaleString('de-DE') : '0', sx + sw / 2, 6.1 * c, sw);
      ctx.restore();
      label('SIEGE', 7.6);
      value(String(rounds[i] || 0), 8.5);
    } else {
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
    }

    // Einblendungen (TETRIS!, Combo, Angriff)
    popups[i].forEach((p, k) => {
      ctx.globalAlpha = Math.max(0, 1 - p.t / 1400);
      ctx.fillStyle = p.color;
      ctx.font = `900 ${Math.round(c * 1.1)}px "Segoe UI", system-ui, sans-serif`;
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 8;
      ctx.fillText(p.text, L.board + COLS * c / 2, (7 + k * 1.4) * c - p.t / 1400 * c, COLS * c * 0.95);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    });

    // Ergebnis / Platzierung auf dem Feld
    const pl = places[i] || 0;
    const ended = phase === 'over' && lastResult;
    if (g && (ended || (pl && N > 2))) {
      const draw = ended && lastResult.winner === -1;
      const won = pl === 1 && !draw;
      let text = won ? 'SIEG' : (draw ? 'REMIS' : (N > 2 ? `PLATZ ${pl}` : 'K.O.'));
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(L.board, H * 0.15 - 1.6 * c, COLS * c, 3.2 * c);
      ctx.fillStyle = won ? '#2ecc71' : (draw ? '#e8ecf8' : (N > 2 ? '#e8ecf8' : '#ff4d5e'));
      ctx.font = `900 ${Math.round(c * 1.6)}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(text, L.board + COLS * c / 2, H * 0.15, COLS * c * 0.95);
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
    $('#rejoin').hidden = true;
    b.classList.remove('rejoining');
  }

  function hideBanner() {
    $('#banner').hidden = true;
  }

  function updateRounds() {
    $('#r0').textContent = rounds[0] || 0;
    $('#r1').textContent = rounds[1] || 0;
    $('#r0').style.color = PLAYER_COLORS[0];
    $('#r1').style.color = PLAYER_COLORS[1];
    const ul = $('#wins');
    ul.innerHTML = '';
    if (N > 2) {
      finalists.forEach((id, i) => {
        const li = document.createElement('li');
        li.style.color = PLAYER_COLORS[i];
        li.textContent = `${finalistName(i)} `;
        const w = document.createElement('span');
        w.className = 'w';
        w.textContent = `${rounds[i] || 0} ${rounds[i] === 1 ? 'Sieg' : 'Siege'}`;
        li.append(w);
        ul.append(li);
      });
    }
  }

  function renderVersus() {
    const box = $('#versus');
    box.innerHTML = '';
    box.classList.toggle('four', N > 2);
    finalists.forEach((id, i) => {
      if (N === 2 && i === 1) {
        const vs = document.createElement('div');
        vs.className = 'vs';
        vs.textContent = 'vs.';
        box.append(vs);
      }
      const d = document.createElement('div');
      d.className = 'fname';
      d.style.color = PLAYER_COLORS[i];
      d.textContent = finalistName(i);
      box.append(d);
    });
  }

  function updateDots() {
    for (let i = 0; i < canvases.length; i++) {
      const p = finalist(i);
      const sec = $('#p' + i);
      if (!sec) continue;
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
    const need = Math.max(2, finalSize);
    $('#count').textContent = n;
    $('#btnStart').disabled = n < need;
    $('#startHint').textContent = n < need ? `Mindestens ${need} Spieler/innen nötig.` : 'Startet, sobald genug dabei sind.';
  }

  function kick(p) {
    if (phase !== 'lobby') return;
    safeSend(p.conn, { type: 'kicked' });
    if (p.conn) p.conn.close();
    players.delete(p.id);
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
  document.querySelectorAll('#finalSize button').forEach(btn => btn.addEventListener('click', () => {
    btn.blur();
    if (phase !== 'lobby') return;
    finalSize = Number(btn.dataset.n);
    document.querySelectorAll('#finalSize button').forEach(b => b.classList.toggle('on', b === btn));
    updateLobby();
  }));
  onClick('#btnNewRoom', () => { if (confirm('Neuen Raum mit neuem Code öffnen? Alle Handys müssen dann neu scannen.')) newRoom(); });
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

  // Zugriff für automatische Tests
  window.__host = { get games() { return games; }, get places() { return places; }, get phase() { return phase; } };

  // ---------- Start ----------
  if (location.protocol === 'file:') $('#fileWarn').hidden = false;
  updateLobby();
  requestAnimationFrame(loop);
  let saved = null;
  try { saved = sessionStorage.getItem('tetrisRoom'); } catch (e) { /* egal */ }
  startNet(saved || newCode());
})();
