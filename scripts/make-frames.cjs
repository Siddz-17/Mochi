#!/usr/bin/env node
/*
 * make-frames.cjs — Mochi sprite authoring tool.
 *
 * All Mochi pixel art is 100% original, authored here. This script is the
 * "pixel artist": it draws an original chibi white dog (Japanese Spitz /
 * Shiba feel — fluffy white fur, curled tail, triangle ears, black bean
 * eyes, tiny nose) with a tiny pixel-shape library, then emits one ASCII
 * grid file per animation under assets/sprites/frames/*.txt.
 *
 * Pixel rules enforced by construction:
 *   - 32x32 frames, one ASCII char per pixel
 *   - ~11 color palette (see ../assets/sprites/palette.json)
 *   - 1px dark-gray outline (#3a3f4a), never pure black on white fur
 *   - no anti-aliasing, no gradients, no blur (nearest-neighbor only)
 *
 * Run: node scripts/make-frames.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const W = 32, H = 32;
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'sprites', 'frames');

/* ---------------- tiny pixel library ---------------- */

function grid() {
  const g = [];
  for (let y = 0; y < H; y++) g.push(new Array(W).fill('.'));
  return g;
}
function px(g, x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  g[y][x] = c;
}
function hline(g, x0, x1, y, c) {
  for (let x = Math.round(x0); x <= Math.round(x1); x++) px(g, x, y, c);
}
function fillRect(g, x0, y0, x1, y1, c) {
  for (let y = Math.round(y0); y <= Math.round(y1); y++) hline(g, x0, x1, y, c);
}
function ellipse(g, cx, cy, rx, ry, c) {
  if (rx <= 0 || ry <= 0) return;
  for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++) {
    const t = (y - cy) / ry;
    if (Math.abs(t) > 1) continue;
    const dx = rx * Math.sqrt(1 - t * t);
    hline(g, Math.ceil(cx - dx), Math.floor(cx + dx), y, c);
  }
}
function disc(g, cx, cy, r, c) { ellipse(g, cx, cy, r, r, c); }
function line(g, x0, y0, x1, y1, c) {
  x0 = Math.round(x0); y0 = Math.round(y0);
  x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (;;) {
    px(g, x, y, c);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}
function tri(g, p, c) {
  const ys = p.map(q => q[1]);
  for (let y = Math.ceil(Math.min(...ys)); y <= Math.floor(Math.max(...ys)); y++) {
    const xs = [];
    const edges = [[p[0], p[1]], [p[1], p[2]], [p[2], p[0]]];
    for (const [[x1, y1], [x2, y2]] of edges) {
      if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) xs.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
    }
    if (xs.length >= 2) {
      xs.sort((a, b) => a - b);
      hline(g, Math.ceil(xs[0]), Math.floor(xs[xs.length - 1]), y, c);
    }
  }
}
function growTri(p, f) {
  const cx = (p[0][0] + p[1][0] + p[2][0]) / 3;
  const cy = (p[0][1] + p[1][1] + p[2][1]) / 3;
  return p.map(([x, y]) => [Math.round(cx + (x - cx) * f), Math.round(cy + (y - cy) * f)]);
}
/* outlined shapes: draw silhouette in outline color, then fill */
function eBlob(g, cx, cy, rx, ry, fill, ol) {
  ellipse(g, cx, cy, rx + 1, ry + 1, ol || 'o');
  ellipse(g, cx, cy, rx, ry, fill);
}
function rBlob(g, x0, y0, x1, y1, fill, ol) {
  fillRect(g, x0 - 1, y0 - 1, x1 + 1, y1 + 1, ol || 'o');
  fillRect(g, x0, y0, x1, y1, fill);
}
function tBlob(g, p, fill, ol) {
  tri(g, growTri(p, 1.35), ol || 'o');
  tri(g, p, fill);
}
/* outlined thick limb from (x0,y0) to (x1,y1) */
function limb(g, x0, y0, x1, y1, fill, w) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    disc(g, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, ((w || 3) + 2) / 2, 'o');
  }
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    disc(g, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, (w || 3) / 2, fill);
  }
}
/* outline the non-transparent pixels of an icon inside a bbox */
function autoOutline(g, x0, y0, x1, y1, fgChars) {
  const fgs = new Set(fgChars);
  const pts = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!fgs.has(g[y][x])) continue;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1 && g[ny][nx] === '.') pts.push([nx, ny]);
    }
  }
  for (const [x, y] of pts) g[y][x] = 'o';
}
function blit(dst, src, dx, dy) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = src[y][x];
    if (c === '.') continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < W && ny < H) dst[ny][nx] = c;
  }
}
function blitColumns(dst, src, x0) {
  for (let y = 0; y < H; y++) for (let x = x0; x < W; x++) {
    if (src[y][x] !== '.') dst[y][x] = src[y][x];
  }
}
function mirrorX(src) {
  const g = grid();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y][W - 1 - x] = src[y][x];
  return g;
}

/* ---------------- Mochi the dog ----------------
 * Chibi white dog, front view: big round head (cx 16, cy 13, r 11x8),
 * sitting body (cx 16, cy 24), triangle ears, curled tail at right.
 */

function archUp(g, cx, cy, w, h, c) {          // ∩  happy closed eye
  for (let i = 0; i <= w; i++) {
    const t = (i / w) * 2 - 1;
    px(g, cx - Math.floor(w / 2) + i, cy - Math.round((1 - t * t) * h), c);
  }
}
function archDown(g, cx, cy, w, h, c) {        // ∪  content / sleeping eye
  for (let i = 0; i <= w; i++) {
    const t = (i / w) * 2 - 1;
    px(g, cx - Math.floor(w / 2) + i, cy + Math.round((1 - t * t) * h), c);
  }
}

/* ears: style up | perk | flat | droop. flip mirrors around bx. */
function drawEar(g, bx, by, style, flip) {
  const M = d => (flip ? bx - d : bx + d);
  let outer, inner = null;
  if (style === 'perk') {
    outer = [[M(-4), by + 3], [M(-1), by - 6], [M(3), by + 2]];
    inner = [[M(-2), by + 1], [M(-1), by - 3], [M(1), by + 1]];
  } else if (style === 'flat') {
    outer = [[M(-5), by + 1], [M(0), by - 1], [M(4), by + 3]];
  } else if (style === 'droop') {
    outer = [[M(-4), by - 1], [M(-2), by + 6], [M(2), by + 1]];
  } else { // up — friendly triangle ear
    outer = [[M(-4), by + 3], [M(-1), by - 5], [M(3), by + 2]];
    inner = [[M(-2), by + 1], [M(-1), by - 2], [M(1), by + 1]];
  }
  tBlob(g, outer, 'W');
  if (inner) tri(g, inner, 'C'); // cream inner ear
}

/* eyes centered on (cx,cy); styles: open closed happy squint sleep half sad dizzy */
function drawEyes(g, cx, cy, style) {
  const L = cx - 4, R = cx + 4;
  if (style === 'open') {
    fillRect(g, L - 1, cy - 1, L, cy + 1, 'E');
    fillRect(g, R - 1, cy - 1, R, cy + 1, 'E');
    px(g, L - 1, cy - 1, 'W'); px(g, R - 1, cy - 1, 'W'); // sparkle highlight
  } else if (style === 'closed') {
    hline(g, L - 2, L + 1, cy, 'E'); hline(g, R - 2, R + 1, cy, 'E');
  } else if (style === 'happy') {
    archUp(g, L, cy + 1, 4, 2, 'E'); archUp(g, R, cy + 1, 4, 2, 'E');
  } else if (style === 'squint' || style === 'sleep') {
    archDown(g, L, cy, 4, 1, 'E'); archDown(g, R, cy, 4, 1, 'E');
  } else if (style === 'half') {
    hline(g, L - 1, L, cy, 'E'); hline(g, R - 1, R, cy, 'E');
  } else if (style === 'sad') {
    fillRect(g, L - 1, cy, L, cy + 1, 'E');
    fillRect(g, R - 1, cy, R, cy + 1, 'E');
    line(g, L - 2, cy - 2, L + 1, cy - 3, 'E');   // worried brows, inner ends up
    line(g, R - 1, cy - 3, R + 2, cy - 2, 'E');
  } else if (style === 'dizzy') {
    line(g, L - 1, cy - 1, L + 1, cy + 1, 'E'); line(g, L + 1, cy - 1, L - 1, cy + 1, 'E');
    line(g, R - 1, cy - 1, R + 1, cy + 1, 'E'); line(g, R + 1, cy - 1, R - 1, cy + 1, 'E');
  }
}

function drawNose(g, nx, ny) {
  fillRect(g, nx - 1, ny, nx + 1, ny, 'E');
  px(g, nx, ny + 1, 'E');
}

/* mouth styles: smile tongue open big frown flat none */
function drawMouth(g, nx, ny, style) {
  const my = ny + 2;
  if (style === 'smile' || style === 'tongue') {
    px(g, nx - 2, my, 'E'); px(g, nx + 2, my, 'E');
    hline(g, nx - 1, nx + 1, my + 1, 'E');
    if (style === 'tongue') rBlob(g, nx - 1, my + 1, nx + 1, my + 3, 'T');
  } else if (style === 'open') {
    ellipse(g, nx, my + 1, 2, 2, 'E');
  } else if (style === 'big') {
    eBlob(g, nx, my + 2, 3, 4, 'E');
    ellipse(g, nx, my + 3, 2, 2, 'T'); // tongue inside the yawn/bark
  } else if (style === 'frown') {
    hline(g, nx - 2, nx + 2, my + 1, 'E');
    px(g, nx - 2, my, 'E'); px(g, nx + 2, my, 'E');
  } else if (style === 'flat') {
    hline(g, nx - 2, nx + 2, my + 1, 'E');
  }
}

const TAIL_POS = {
  curl: [26, 22], wagL: [22, 20], wagC: [26, 18], wagR: [29, 21],
  down: [26, 27], up: [26, 16],
};

/* Front-view sitting dog. The workhorse for most animations. */
function drawDogFront(g, o) {
  o = o || {};
  const dx = o.dx || 0, dy = o.dy || 0;
  const squash = o.squash || 0, stretchY = o.stretchY || 0;
  const headDX = o.headDX || 0, headDY = o.headDY || 0;
  const bodyDY = o.bodyDY || 0, breathe = o.breathe || 0;

  /* tail (behind body) */
  if (o.tail !== 'none') {
    const tp = TAIL_POS[o.tail || 'curl'];
    const tx = tp[0] + dx + (o.tailDX || 0), ty = tp[1] + dy + (o.tailDY || 0);
    eBlob(g, tx, ty, 4, 4, 'W');
    disc(g, tx, ty, 2, '1');          // inner curl shading
    disc(g, tx + 2, ty - 2, 1, 'C');  // cream tail tip
  }

  /* body */
  const bx = 16 + dx, by = 24 + dy + bodyDY;
  eBlob(g, bx, by, 8 + squash, 7 - squash + breathe + stretchY, 'W');
  ellipse(g, bx, by + 3, 6, 2, '1');                       // belly shade
  ellipse(g, bx - 7, by + 3, 3, 3, '1');                   // haunch fluff
  ellipse(g, bx + 7, by + 3, 3, 3, '1');

  /* front legs */
  const legs = o.legs || 'stand';
  const legY0 = 24 + dy + bodyDY, legY1 = 30 + dy + bodyDY;
  if (legs === 'stand' || legs === 'tuck' || legs === 'dangle' || legs === 'reach') {
    const top = legs === 'tuck' ? legY0 + 2 : legs === 'dangle' ? legY0 + 3 : legY0;
    const bot = legs === 'reach' ? 31 + dy : legY1;
    rBlob(g, 11 + dx, top, 13 + dx, bot, 'W');
    rBlob(g, 19 + dx, top, 21 + dx, bot, 'W');
    if (legs === 'dangle') { // back legs dangle too
      rBlob(g, 8 + dx, legY0 + 2, 10 + dx, 31 + dy, 'W');
      rBlob(g, 22 + dx, legY0 + 2, 24 + dx, 31 + dy, 'W');
    }
  }

  /* head */
  const hx = 16 + dx + headDX, hy = 13 + dy + headDY;
  drawEar(g, hx - 6, hy - 6, o.earL || 'up', false);
  drawEar(g, hx + 6, hy - 6, o.earR || 'up', true);
  eBlob(g, hx, hy, 11, 8, 'W');
  ellipse(g, hx, hy + 7, 5, 1, '1'); // low chin shade, clear of the mouth
  tBlob(g, [[hx - 11, hy + 1], [hx - 8, hy + 3], [hx - 11, hy + 6]], 'W'); // cheek ruff
  tBlob(g, [[hx + 11, hy + 1], [hx + 8, hy + 3], [hx + 11, hy + 6]], 'W');

  /* face */
  const eye = o.eye || 'open';
  drawEyes(g, hx + (o.eyeDX || 0), 12 + dy + headDY + (o.eyeDY || 0), eye);
  const nx = hx + (o.noseDX || 0), ny = 15 + dy + headDY + (o.noseDY || 0);
  drawNose(g, nx, ny);
  drawMouth(g, nx, ny, o.mouth || 'smile');
  if (o.blush || o.blushBig) {
    const s = o.blushBig ? 2 : 1, bwy = 15 + dy + headDY;
    fillRect(g, hx - 9, bwy, hx - 9 + s, bwy + 1, 'P');
    fillRect(g, hx + 9 - s, bwy, hx + 9, bwy + 1, 'P');
  }
  if (o.tear) { // falling tear under left eye
    const ty2 = 16 + dy + headDY + (o.tearY || 0);
    px(g, hx - 5, ty2, 'B'); px(g, hx - 5, ty2 + 1, 'B');
  }

  /* think: paw up to chin (drawn over head) */
  if (o.chin) eBlob(g, hx + 5, hy + 5 + o.chin, 2, 2, 'W');

  /* work: desk + typing paws */
  if (o.desk) {
    fillRect(g, 4 + dx, 28 + dy, 28 + dx, 31 + dy, '2');
    hline(g, 4 + dx, 28 + dx, 28 + dy, 'o');
    hline(g, 6 + dx, 26 + dx, 29 + dy, 'o'); // desk front edge detail
    eBlob(g, 12 + dx, 27 + dy + (o.typeL || 0), 2, 2, 'W');
    eBlob(g, 20 + dx, 27 + dy + (o.typeR || 0), 2, 2, 'W');
  }

  /* scratch: hind leg up to ear + motion ticks */
  if (o.scratch) {
    const jx = o.scratch[0], jy = o.scratch[1];
    limb(g, 10 + dx, 25 + dy, 6 + dx + jx, 12 + dy + jy, 'W', 3);
    eBlob(g, 6 + dx + jx, 12 + dy + jy, 2, 2, 'W');
    px(g, 3 + dx + jx, 9 + dy + jy, 'B'); px(g, 4 + dx + jx, 8 + dy + jy, 'B');
    px(g, 9 + dx + jx, 7 + dy + jy, 'B'); px(g, 10 + dx + jx, 6 + dy + jy, 'B');
  }
}

/* side-view leg poses: 0 stance, 1 lifted, 2 stance, 3 reach-forward */
function drawSideLeg(g, x, phase, fill) {
  const y0 = 25, y1 = 31;
  if (phase === 0 || phase === 2) rBlob(g, x, y0, x + 2, y1, fill);
  else if (phase === 1) rBlob(g, x, y0 + 2, x + 2, y1 - 1, fill);
  else rBlob(g, x - 2, y0, x, y1, fill);
}

function drawSideEar(t, hx, hy, style, back) {
  const sx = back ? 4 : 0;
  let outer, inner = null;
  if (style === 'flat') outer = [[hx - 6 + sx, hy - 2], [hx - 1 + sx, hy - 5], [hx + 2 + sx, hy - 1]];
  else if (style === 'droop') outer = [[hx - 5 + sx, hy - 4], [hx - 6 + sx, hy + 2], [hx - 1 + sx, hy - 2]];
  else { outer = [[hx - 5 + sx, hy - 3], [hx - 3 + sx, hy - 9], [hx + 1 + sx, hy - 4]]; inner = [[hx - 4 + sx, hy - 4], [hx - 3 + sx, hy - 7], [hx - 1 + sx, hy - 4]]; }
  tBlob(t, outer, 'W');
  if (inner) tri(t, inner, 'C');
}

/* Side-view dog facing left (mirrored for right). Used by walk animations. */
function drawDogSide(g, o) {
  o = o || {};
  const facing = o.facing || 'left';
  const t = grid();
  const legFrame = o.legFrame || 0;
  const headDY = o.headDY || 0, tailDY = o.tailDY || 0;

  eBlob(t, 26, 15 + tailDY, 3, 3, 'W');   // curled tail
  disc(t, 26, 15 + tailDY, 1, '1');
  drawSideLeg(t, 13, (legFrame + 2) % 4, '1'); // far legs in shade
  drawSideLeg(t, 23, legFrame, '1');
  eBlob(t, 17, 21, 9, 6, 'W');           // body
  ellipse(t, 17, 24, 7, 2, '1');
  drawSideLeg(t, 11, legFrame, 'W');     // near legs
  drawSideLeg(t, 21, (legFrame + 2) % 4, 'W');

  const hx = 9, hy = 13 + headDY;        // head
  drawSideEar(t, hx, hy, o.ear || 'up', true);
  eBlob(t, hx, hy, 6, 6, 'W');
  drawSideEar(t, hx, hy, o.ear || 'up', false);
  rBlob(t, 2, hy + 1, 6, hy + 4, 'W');   // snout
  fillRect(t, 2, hy + 1, 3, hy + 3, 'E'); // nose
  const eye = o.eye || 'open';           // single visible eye
  if (eye === 'open') { fillRect(t, 7, hy - 2, 8, hy, 'E'); px(t, 7, hy - 2, 'W'); }
  else if (eye === 'happy') archUp(t, 8, hy, 3, 2, 'E');
  else archDown(t, 8, hy - 1, 3, 1, 'E');
  if (o.tongue) rBlob(t, 3, hy + 5, 5, hy + 7, 'T');

  blit(g, facing === 'right' ? mirrorX(t) : t, o.dx || 0, o.dy || 0);
}

/* lying-down sleep pose */
function drawSleep(g, o) {
  o = o || {};
  const dx = o.dx || 0, dy = o.dy || 0, breathe = o.breathe || 0;
  eBlob(g, 25 + dx, 25 + dy, 3, 3, 'W');   // tail curled around
  disc(g, 25 + dx, 25 + dy, 1, '1');
  eBlob(g, 16 + dx, 24 + dy, 10, 5 + breathe, 'W'); // body, breathing
  ellipse(g, 16 + dx, 26 + dy, 8, 2, '1');
  const hx = 7 + dx, hy = 22 + dy;         // head resting on paws
  tBlob(g, [[hx - 3, hy - 4], [hx - 5, hy + 2], [hx, hy - 2]], 'W'); // flopped ear
  eBlob(g, hx, hy, 5, 5, 'W');
  rBlob(g, 1 + dx, hy, 4 + dx, hy + 3, 'W'); // snout
  fillRect(g, 1 + dx, hy, 2 + dx, hy + 2, 'E'); // nose
  archDown(g, hx - 1, hy - 1, 3, 1, 'E');   // closed eye
  rBlob(g, 1 + dx, 26 + dy, 9 + dx, 29 + dy, 'W'); // front paws stretched out
  line(g, 5 + dx, 27 + dy, 5 + dx, 29 + dy, 'o');  // toe separator
}

/* ---------------- effects (32x32, transparent bg) ---------------- */

const HEART_SM = [
  '.XX.XX.',
  'XXXXXXX',
  'XXXXXXX',
  '.XXXXX.',
  '..XXX..',
  '...X...',
];
const HEART_BIG = [
  '.XXX.XXX.',
  'XXXXXXXXX',
  'XXXXXXXXX',
  'XXXXXXXXX',
  '.XXXXXXX.',
  '..XXXXX..',
  '...XXX...',
  '....X....',
];
function stamp(g, pat, ox, oy, c) {
  for (let y = 0; y < pat.length; y++)
    for (let x = 0; x < pat[y].length; x++)
      if (pat[y][x] !== '.') px(g, ox + x, oy + y, c);
}
const Z_PAT = ['ZZZZZ', '...ZZ', '..ZZ.', '.ZZ..', 'ZZZZZ'];

function drawEffect(g, name, f) {
  if (name === 'fx-heart') {
    const big = f > 0;
    const pat = big ? HEART_BIG : HEART_SM;
    const ox = 16 - Math.floor(pat[0].length / 2), oy = 13 - (f === 2 ? 1 : 0);
    stamp(g, pat, ox, oy, 'T');
    autoOutline(g, ox - 1, oy - 1, ox + pat[0].length, oy + pat.length, ['T']);
  } else if (name === 'fx-sparkle') {
    const L = [2, 3, 4, 3][f], cx = 16, cy = 16;
    line(g, cx, cy - L, cx, cy + L, 'Y');
    line(g, cx - L, cy, cx + L, cy, 'Y');
    const d = Math.max(1, Math.floor(L / 2));
    line(g, cx - d, cy - d, cx + d, cy + d, 'Y');
    line(g, cx - d, cy + d, cx + d, cy - d, 'Y');
    px(g, cx, cy, 'W');
    autoOutline(g, cx - L - 1, cy - L - 1, cx + L + 1, cy + L + 1, ['Y']);
  } else if (name === 'fx-ellipsis') {
    for (let i = 0; i < 3; i++) {
      const x = 10 + i * 6, y = 20 - (i === f ? 3 : 0);
      disc(g, x, y, 2, 'o'); disc(g, x, y, 1, 'E');
    }
  } else if (name === 'fx-exclaim') {
    const dy = f === 1 ? -3 : 0;
    rBlob(g, 15, 9 + dy, 17, 17 + dy, 'Y');
    disc(g, 16, 21 + dy, 2, 'o'); disc(g, 16, 21 + dy, 1, 'Y');
  } else if (name === 'fx-zzz') {
    // two Z's rising in a seamless 16px vertical loop (shift 8px over 4 frames)
    for (let k = 0; k < 2; k++) {
      const y = 6 + (((k * 8 - 2 * f) % 16) + 16) % 16;
      stamp(g, Z_PAT, 13, y, 'Z');
      autoOutline(g, 12, y - 1, 19, y + 5, ['Z']);
    }
  } else if (name === 'fx-steam') {
    for (const bx of [11, 16, 21]) {
      for (let y = 28; y >= 8; y--) {
        const xo = Math.round(Math.sin((y + f * 4) * 0.5) * 2);
        px(g, bx + xo, y, 'B');
      }
    }
  } else if (name === 'fx-sweat') {
    const oy = f === 0 ? 8 : 14;
    stamp(g, ['.B.', 'BBB', 'BBB', '.B.'], 15, oy, 'B');
    px(g, 15, oy + 1, 'W');
    autoOutline(g, 14, oy - 1, 18, oy + 4, ['B']);
  }
}

/* ---------------- animation definitions ----------------
 * Each entry: name, frames (arrays of drawDogFront/drawDogSide/drawSleep
 * option objects, or {fx:true} for effects), optional timing override.
 * draw: 'front' | 'side' | 'sleep' | 'fx' | 'peek' | 'wake'
 */

const ANIMS = [
  { name: 'idle-sit', timing: [250, 250, 250], draw: 'front', frames: [
    {},
    { breathe: 1, tail: 'wagC' },
    { tail: 'wagR' },
  ]},
  { name: 'blink', timing: [120, 120], draw: 'front', frames: [
    { eye: 'open' },
    { eye: 'closed' },
  ]},
  { name: 'tail-wag', timing: [150, 150, 150, 150], draw: 'front', frames: [
    { tail: 'wagL', dx: -1 },
    { tail: 'wagC' },
    { tail: 'wagR', dx: 1 },
    { tail: 'wagC' },
  ]},
  { name: 'ear-twitch', draw: 'front', frames: [
    {},
    { earL: 'flat' },
  ]},
  { name: 'look-left', draw: 'front', frames: [
    { headDX: -1, eyeDX: -1, noseDX: -1 },
    { headDX: -2, eyeDX: -1, noseDX: -1 },
  ]},
  { name: 'look-right', draw: 'front', frames: [
    { headDX: 1, eyeDX: 1, noseDX: 1 },
    { headDX: 2, eyeDX: 1, noseDX: 1 },
  ]},
  { name: 'look-up', draw: 'front', frames: [
    { headDY: -1, eyeDY: -1 },
    { headDY: -2, eyeDY: -1, earL: 'perk', earR: 'perk' },
  ]},
  { name: 'look-down', draw: 'front', frames: [
    { headDY: 1, eyeDY: 1 },
    { headDY: 1, eyeDY: 2, earL: 'flat', earR: 'flat' },
  ]},
  { name: 'walk-left', timing: [120, 120, 120, 120], draw: 'side', frames: [
    { facing: 'left', legFrame: 0, dy: 0 },
    { facing: 'left', legFrame: 1, dy: -1 },
    { facing: 'left', legFrame: 2, dy: 0 },
    { facing: 'left', legFrame: 3, dy: -1 },
  ]},
  { name: 'walk-right', timing: [120, 120, 120, 120], draw: 'side', frames: [
    { facing: 'right', legFrame: 0, dy: 0 },
    { facing: 'right', legFrame: 1, dy: -1 },
    { facing: 'right', legFrame: 2, dy: 0 },
    { facing: 'right', legFrame: 3, dy: -1 },
  ]},
  { name: 'sleep', timing: [600, 600, 600], draw: 'sleep', frames: [
    { breathe: 0 }, { breathe: 1 }, { breathe: 0 },
  ]},
  { name: 'wake', draw: 'wake', frames: [
    { breathe: 0 },            // still lying down
    { eye: 'half', headDY: 1 },// sitting up, groggy
    { eye: 'open' },           // fully awake
  ]},
  { name: 'yawn', draw: 'front', frames: [
    {},
    { eye: 'squint', mouth: 'open' },
    { eye: 'closed', mouth: 'big', headDY: -1 },
    { eye: 'squint', mouth: 'open' },
  ]},
  { name: 'stretch', draw: 'front', frames: [
    {},
    { bodyDY: 1, legs: 'reach', headDY: -1 },
    { bodyDY: 2, legs: 'reach', headDY: -2, earL: 'perk', earR: 'perk', tail: 'up', mouth: 'tongue' },
  ]},
  { name: 'scratch', draw: 'front', frames: [
    { headDX: -1, eye: 'squint', scratch: [0, 0] },
    { headDX: -1, eye: 'squint', scratch: [1, 2] },
    { headDX: -1, eye: 'squint', scratch: [0, 1] },
  ]},
  { name: 'happy', draw: 'front', frames: [
    { eye: 'happy', mouth: 'tongue', blush: true, tail: 'wagL', dy: 0 },
    { eye: 'happy', mouth: 'tongue', blush: true, tail: 'wagR', dy: -1 },
    { eye: 'happy', mouth: 'tongue', blush: true, tail: 'wagL', dy: 0 },
    { eye: 'happy', mouth: 'tongue', blush: true, tail: 'wagR', dy: -1 },
  ]},
  { name: 'pet-squint', draw: 'front', frames: [
    { eye: 'squint', blushBig: true, mouth: 'smile' },
    { eye: 'squint', blushBig: true, mouth: 'smile', headDX: 1, headDY: 1 },
    { eye: 'squint', blushBig: true, mouth: 'smile' },
  ]},
  { name: 'hop', timing: [130, 130, 130], draw: 'front', frames: [
    { squash: 2 },
    { dy: -7, legs: 'tuck', tail: 'up', eye: 'happy', mouth: 'tongue' },
    { squash: 2 },
  ]},
  { name: 'sad', draw: 'front', frames: [
    { earL: 'droop', earR: 'droop', eye: 'sad', mouth: 'frown', tail: 'down', tear: true, tearY: 0 },
    { earL: 'droop', earR: 'droop', eye: 'sad', mouth: 'frown', tail: 'down', tear: true, tearY: 2, headDY: 1 },
  ]},
  { name: 'think', draw: 'front', frames: [
    { headDX: 1, eyeDY: -1, eyeDX: 1, chin: 0, mouth: 'flat' },
    { headDX: 1, eyeDY: -1, eyeDX: 1, chin: -1, mouth: 'flat' },
    { headDX: 1, eyeDY: -1, eyeDX: 1, chin: 0, mouth: 'flat' },
  ]},
  { name: 'work', timing: [140, 140, 140, 140], draw: 'front', frames: [
    { desk: true, eyeDY: 1, headDY: 1, typeL: 0, typeR: 0 },
    { desk: true, eyeDY: 1, headDY: 1, typeL: -2, typeR: 0 },
    { desk: true, eyeDY: 1, headDY: 1, typeL: 0, typeR: -2 },
    { desk: true, eyeDY: 1, headDY: 1, typeL: 0, typeR: 0 },
  ]},
  { name: 'alert-bark', draw: 'front', frames: [
    { headDY: -2, earL: 'perk', earR: 'perk', mouth: 'none' },
    { headDY: -2, earL: 'perk', earR: 'perk', mouth: 'open', headDX: 1 },
    { headDY: -2, earL: 'perk', earR: 'perk', mouth: 'big', headDX: -1 },
    { headDY: -2, earL: 'perk', earR: 'perk', mouth: 'open' },
  ]},
  { name: 'drag-dangle', draw: 'front', frames: [
    { stretchY: 3, headDY: -3, earL: 'droop', earR: 'droop', eye: 'dizzy', mouth: 'tongue', legs: 'dangle', tail: 'down', dx: -1 },
    { stretchY: 3, headDY: -3, earL: 'droop', earR: 'droop', eye: 'dizzy', mouth: 'tongue', legs: 'dangle', tail: 'down', dx: 0 },
    { stretchY: 3, headDY: -3, earL: 'droop', earR: 'droop', eye: 'dizzy', mouth: 'tongue', legs: 'dangle', tail: 'down', dx: 1 },
  ]},
  { name: 'drop-bounce', draw: 'front', frames: [
    { dy: -6, legs: 'tuck', tail: 'up' },
    { squash: 3 },
    { squash: 1 },
  ]},
  { name: 'peek', draw: 'peek', frames: [
    { dx: 6 }, { dx: 9 }, { dx: 7 },
  ]},
  /* effects */
  { name: 'fx-heart', draw: 'fx', frames: [{}, {}, {}] },
  { name: 'fx-sparkle', draw: 'fx', frames: [{}, {}, {}, {}] },
  { name: 'fx-ellipsis', draw: 'fx', frames: [{}, {}, {}] },
  { name: 'fx-exclaim', draw: 'fx', frames: [{}, {}] },
  { name: 'fx-zzz', draw: 'fx', frames: [{}, {}, {}, {}] },
  { name: 'fx-steam', draw: 'fx', frames: [{}, {}, {}] },
  { name: 'fx-sweat', draw: 'fx', frames: [{}, {}] },
];

/* ---------------- file writing ---------------- */

const LEGEND = '# Legend: .=transparent o=outline(#3a3f4a) W=fur(#ffffff) 1=furShade1(#dfe6ec) 2=furShade2(#b7c2d1) C=cream(#f6e7c6) E=eyeNose(#23262e) T=tongue(#f5a3b5) P=blush(#f6c9d4) Y=effectYellow(#ffd94d) B=effectBlue(#7fc4ff) Z=zzz(#9fb6ff)';

function renderFrame(anim, opts, frameIndex) {
  const g = grid();
  if (anim.draw === 'front') drawDogFront(g, opts);
  else if (anim.draw === 'side') drawDogSide(g, opts);
  else if (anim.draw === 'sleep') drawSleep(g, opts);
  else if (anim.draw === 'wake') {
    if (frameIndex === 0) drawSleep(g, opts);
    else drawDogFront(g, opts);
  } else if (anim.draw === 'peek') {
    const t = grid();
    drawDogFront(t, Object.assign({ eye: 'open', mouth: 'smile', tail: 'curl' }, opts));
    blitColumns(g, t, 13); // dog hides behind the left edge, peeking out
  } else if (anim.draw === 'fx') drawEffect(g, anim.name, frameIndex);
  return g;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let total = 0;
  for (const anim of ANIMS) {
    const lines = [];
    lines.push('# Mochi animation: ' + anim.name);
    lines.push('# 32x32 ASCII pixels; one char per pixel; 32 rows per frame; frames separated by ---FRAME---');
    lines.push(LEGEND);
    lines.push('# frames: ' + anim.frames.length);
    if (anim.timing) lines.push('# timing: ' + anim.timing.join(','));
    anim.frames.forEach((opts, i) => {
      const g = renderFrame(anim, opts, i);
      if (i > 0) lines.push('---FRAME---');
      for (const row of g) lines.push(row.join(''));
    });
    lines.push('');
    fs.writeFileSync(path.join(OUT, anim.name + '.txt'), lines.join('\n'));
    total += anim.frames.length;
    console.log('wrote ' + anim.name + '.txt (' + anim.frames.length + ' frames)');
  }
  console.log('total frames: ' + total);
}

main();
