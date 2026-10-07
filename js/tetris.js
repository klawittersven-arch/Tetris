/*
 * Tetris-Spiellogik (ohne DOM). Wird vom Beamer (host.js) benutzt.
 * Koordinaten: x nach rechts, y nach unten. Das Feld hat 2 versteckte
 * Reihen oben (Spawn-Bereich), sichtbar sind die unteren 20.
 */
(function (root) {
  'use strict';

  const COLS = 10;
  const HIDDEN = 2;
  const VISIBLE = 20;
  const ROWS = VISIBLE + HIDDEN;
  const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

  // Grundform (Rotation 0) als Zellen in einer n×n-Box
  const BASE = {
    I: { n: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
    O: { n: 4, cells: [[1, 0], [2, 0], [1, 1], [2, 1]] },
    T: { n: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
    S: { n: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
    Z: { n: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
    J: { n: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
    L: { n: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
  };

  // Alle 4 Rotationen vorberechnen (im Uhrzeigersinn: (x,y) -> (n-1-y, x))
  const SHAPES = {};
  for (const t of TYPES) {
    const { n, cells } = BASE[t];
    const rots = [cells];
    for (let r = 1; r < 4; r++) {
      if (t === 'O') { rots.push(cells); continue; }
      rots.push(rots[r - 1].map(([x, y]) => [n - 1 - y, x]));
    }
    SHAPES[t] = rots;
  }

  // SRS-Wall-Kicks (y nach oben wie im Standard, wird beim Anwenden negiert)
  const KICKS_JLSTZ = {
    '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  };
  const KICKS_I = {
    '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  };

  const LINE_SCORE = [0, 100, 300, 500, 800];
  const LINE_ATTACK = [0, 0, 1, 2, 4];
  const COMBO_ATTACK = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];
  const LOCK_DELAY = 500;      // ms
  const MAX_LOCK_RESETS = 15;
  const SOFT_DROP_FACTOR = 20;
  const LEVEL_TIME = 45000;    // alle 45 s steigt das Level zusätzlich
  const MAX_GARBAGE_PER_LOCK = 8;

  // Deterministischer Zufall, damit beide Spieler dieselbe Steinfolge bekommen
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gravityInterval(level) {
    // Guideline-Formel: Sekunden pro Reihe
    const l = Math.min(level, 20);
    return Math.pow(0.8 - (l - 1) * 0.007, l - 1) * 1000;
  }

  class Game {
    constructor(seed, garbageSeed) {
      this.bagRng = mulberry32(seed);
      this.garbageRng = mulberry32(garbageSeed === undefined ? seed ^ 0x5bd1e995 : garbageSeed);
      this.board = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
      this.bag = [];
      this.queue = [];
      this.hold = null;
      this.canHold = true;
      this.score = 0;
      this.lines = 0;
      this.level = 1;
      this.combo = -1;
      this.b2b = false;
      this.elapsed = 0;
      this.softDrop = false;
      this.gravityTimer = 0;
      this.lockTimer = 0;
      this.lockResets = 0;
      this.lowestY = 0;
      this.pendingGarbage = []; // Pakete eingehender Müllzeilen
      this.over = false;
      this.events = [];
      this.current = null;
      this.fillQueue();
      this.spawn();
    }

    // ---------- Steinfolge ----------
    fillQueue() {
      while (this.queue.length < 7) {
        if (this.bag.length === 0) {
          this.bag = TYPES.slice();
          for (let i = this.bag.length - 1; i > 0; i--) {
            const j = Math.floor(this.bagRng() * (i + 1));
            [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
          }
        }
        this.queue.push(this.bag.shift());
      }
    }

    nextPieces(count) {
      return this.queue.slice(0, count);
    }

    spawn(type) {
      if (!type) {
        type = this.queue.shift();
        this.fillQueue();
      }
      const piece = { type, rot: 0, x: 3, y: 0 };
      this.current = piece;
      this.lockTimer = 0;
      this.lockResets = 0;
      this.gravityTimer = 0;
      if (this.collides(piece)) {
        this.topOut();
        return;
      }
      // Wie im Original: sofort eine Reihe nach unten, wenn möglich
      if (!this.collides({ ...piece, y: piece.y + 1 })) piece.y++;
      this.lowestY = piece.y;
    }

    // ---------- Kollision ----------
    cells(piece) {
      return SHAPES[piece.type][piece.rot].map(([cx, cy]) => [piece.x + cx, piece.y + cy]);
    }

    collides(piece) {
      for (const [x, y] of this.cells(piece)) {
        if (x < 0 || x >= COLS || y >= ROWS) return true;
        if (y >= 0 && this.board[y][x]) return true;
      }
      return false;
    }

    onGround() {
      return this.collides({ ...this.current, y: this.current.y + 1 });
    }

    // Bewegung am Boden setzt die Lock-Verzögerung zurück (begrenzt)
    afterMove() {
      if (this.current.y > this.lowestY) {
        this.lowestY = this.current.y;
        this.lockResets = 0;
      }
      if (this.onGround() && this.lockResets < MAX_LOCK_RESETS) {
        this.lockTimer = 0;
        this.lockResets++;
      }
    }

    // ---------- Aktionen ----------
    move(dx) {
      if (this.over) return false;
      const p = { ...this.current, x: this.current.x + dx };
      if (this.collides(p)) return false;
      this.current = p;
      this.afterMove();
      return true;
    }

    rotate(dir) {
      if (this.over) return false;
      const c = this.current;
      if (c.type === 'O') return false;
      const to = (c.rot + (dir > 0 ? 1 : 3)) % 4;
      const kicks = (c.type === 'I' ? KICKS_I : KICKS_JLSTZ)[c.rot + '>' + to];
      for (const [kx, ky] of kicks) {
        const p = { ...c, rot: to, x: c.x + kx, y: c.y - ky };
        if (!this.collides(p)) {
          this.current = p;
          this.afterMove();
          return true;
        }
      }
      return false;
    }

    stepDown() {
      const p = { ...this.current, y: this.current.y + 1 };
      if (this.collides(p)) return false;
      this.current = p;
      if (p.y > this.lowestY) {
        this.lowestY = p.y;
        this.lockResets = 0;
      }
      return true;
    }

    ghostY() {
      let y = this.current.y;
      while (!this.collides({ ...this.current, y: y + 1 })) y++;
      return y;
    }

    hardDrop() {
      if (this.over) return;
      const y = this.ghostY();
      this.score += (y - this.current.y) * 2;
      this.current.y = y;
      this.lock();
    }

    holdPiece() {
      if (this.over || !this.canHold) return false;
      const t = this.current.type;
      if (this.hold) {
        const h = this.hold;
        this.hold = t;
        this.spawn(h);
      } else {
        this.hold = t;
        this.spawn();
      }
      this.canHold = false;
      return true;
    }

    // ---------- Zeit ----------
    update(dt) {
      if (this.over) return;
      this.elapsed += dt;
      this.level = 1 + Math.max(Math.floor(this.lines / 10), Math.floor(this.elapsed / LEVEL_TIME));

      if (this.onGround()) {
        this.gravityTimer = 0;
        this.lockTimer += dt;
        if (this.lockTimer >= LOCK_DELAY || this.lockResets >= MAX_LOCK_RESETS && this.lockTimer >= LOCK_DELAY / 5) {
          this.lock();
        }
        return;
      }
      this.lockTimer = 0;
      let interval = gravityInterval(this.level);
      if (this.softDrop) interval = Math.min(interval, Math.max(interval / SOFT_DROP_FACTOR, 25));
      this.gravityTimer += dt;
      while (this.gravityTimer >= interval) {
        this.gravityTimer -= interval;
        if (!this.stepDown()) { this.gravityTimer = 0; break; }
        if (this.softDrop) this.score += 1;
      }
    }

    // ---------- Einrasten & Reihen ----------
    lock() {
      const cells = this.cells(this.current);
      let allHidden = true;
      for (const [x, y] of cells) {
        if (y >= 0) this.board[y][x] = this.current.type;
        if (y >= HIDDEN) allHidden = false;
      }
      this.events.push({ type: 'lock' });

      const cleared = this.clearLines();
      let attack = 0;
      if (cleared > 0) {
        this.combo++;
        const difficult = cleared === 4;
        let pts = LINE_SCORE[cleared] * this.level;
        attack = LINE_ATTACK[cleared];
        if (difficult && this.b2b) { pts = Math.floor(pts * 1.5); attack += 1; }
        this.b2b = difficult ? true : false;
        pts += 50 * this.combo * this.level;
        attack += COMBO_ATTACK[Math.min(this.combo, COMBO_ATTACK.length - 1)];
        if (this.board.every(row => row.every(c => !c))) { attack += 4; pts += 2000 * this.level; } // Perfect Clear
        this.score += pts;
        this.lines += cleared;

        // Eingehenden Müll zuerst verrechnen
        while (attack > 0 && this.pendingGarbage.length) {
          const take = Math.min(attack, this.pendingGarbage[0]);
          attack -= take;
          this.pendingGarbage[0] -= take;
          if (this.pendingGarbage[0] === 0) this.pendingGarbage.shift();
        }
        this.events.push({ type: 'clear', lines: cleared, attack, combo: this.combo, b2b: this.b2b && difficult });
      } else {
        this.combo = -1;
        this.applyGarbage();
      }

      if (allHidden) { this.topOut(); return; }
      if (this.over) return;
      this.canHold = true;
      this.spawn();
    }

    clearLines() {
      let cleared = 0;
      for (let y = ROWS - 1; y >= 0; y--) {
        if (this.board[y].every(c => c)) {
          this.board.splice(y, 1);
          this.board.unshift(new Array(COLS).fill(null));
          cleared++;
          y++; // dieselbe Zeile erneut prüfen
        }
      }
      return cleared;
    }

    receiveGarbage(amount) {
      if (amount > 0 && !this.over) this.pendingGarbage.push(amount);
    }

    pendingTotal() {
      return this.pendingGarbage.reduce((a, b) => a + b, 0);
    }

    applyGarbage() {
      let budget = MAX_GARBAGE_PER_LOCK;
      let added = 0;
      while (budget > 0 && this.pendingGarbage.length) {
        const n = Math.min(budget, this.pendingGarbage[0]);
        const hole = Math.floor(this.garbageRng() * COLS);
        for (let i = 0; i < n; i++) {
          const top = this.board.shift();
          if (top.some(c => c)) this.over = true; // aus dem Feld gedrückt
          const row = new Array(COLS).fill('G');
          row[hole] = null;
          this.board.push(row);
        }
        budget -= n;
        added += n;
        this.pendingGarbage[0] -= n;
        if (this.pendingGarbage[0] === 0) this.pendingGarbage.shift();
      }
      if (added) this.events.push({ type: 'garbage', lines: added });
      if (this.over) this.topOut();
    }

    topOut() {
      if (this.events.some(e => e.type === 'gameover')) { this.over = true; return; }
      this.over = true;
      this.events.push({ type: 'gameover' });
    }

    takeEvents() {
      const e = this.events;
      this.events = [];
      return e;
    }
  }

  const api = { Game, SHAPES, TYPES, COLS, ROWS, HIDDEN, VISIBLE, mulberry32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Tetris = api;
})(typeof window !== 'undefined' ? window : globalThis);
