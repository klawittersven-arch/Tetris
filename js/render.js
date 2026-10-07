/*
 * Gemeinsame Zeichenfunktionen für Beamer (Duell) und Handy (Runde 1).
 */
(function (root) {
  'use strict';

  const { SHAPES, COLS, HIDDEN, VISIBLE } = root.Tetris;

  const COLORS = {
    I: '#22d3ee', O: '#facc15', T: '#a855f7', S: '#22c55e',
    Z: '#ef4444', J: '#3b82f6', L: '#f97316', G: '#64748b',
  };

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

  // Spielfeld mit Raster, liegenden Steinen, Ghost und aktuellem Stein
  function drawBoard(ctx, g, bx, by, c) {
    const W = COLS * c, H = VISIBLE * c;
    ctx.fillStyle = '#070b16';
    ctx.fillRect(bx, by, W, H);
    ctx.strokeStyle = 'rgba(80,100,150,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < COLS; x++) { ctx.moveTo(bx + x * c + 0.5, by); ctx.lineTo(bx + x * c + 0.5, by + H); }
    for (let y = 1; y < VISIBLE; y++) { ctx.moveTo(bx, by + y * c + 0.5); ctx.lineTo(bx + W, by + y * c + 0.5); }
    ctx.stroke();
    if (!g) return;

    for (let y = HIDDEN; y < HIDDEN + VISIBLE; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = g.board[y][x];
        if (t) block(ctx, bx + x * c, by + (y - HIDDEN) * c, c, g.over ? '#334155' : COLORS[t]);
      }
    }
    if (g.over || !g.current) return;

    const color = COLORS[g.current.type];
    const ghost = { ...g.current, y: g.ghostY() };
    for (const [x, y] of g.cells(ghost)) {
      if (y < HIDDEN) continue;
      const px = bx + x * c + 2, py = by + (y - HIDDEN) * c + 2;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(2, c * 0.08);
      ctx.strokeRect(px, py, c - 4, c - 4);
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = color;
      ctx.fillRect(px, py, c - 4, c - 4);
      ctx.globalAlpha = 1;
    }
    // Lock-Verzögerung durch leichtes Abdunkeln sichtbar machen
    const fade = g.onGround() ? Math.min(g.lockTimer / 500, 1) * 0.35 : 0;
    for (const [x, y] of g.cells(g.current)) {
      if (y < HIDDEN) continue;
      block(ctx, bx + x * c, by + (y - HIDDEN) * c, c, color, 1 - fade);
    }
  }

  root.TetrisRender = { COLORS, block, miniPiece, drawBoard };
})(window);
