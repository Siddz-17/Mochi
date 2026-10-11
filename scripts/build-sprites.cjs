#!/usr/bin/env node
/*
 * build-sprites.cjs — Mochi sprite pipeline (Node, ZERO dependencies).
 *
 * Reads assets/sprites/palette.json + assets/sprites/frames/*.txt
 * (32x32 ASCII grids, frames separated by `---FRAME---`), packs every frame
 * into assets/sprites/spritesheet.png (8-bit RGBA, hand-written PNG encoder:
 * zlib deflate via node:zlib, CRC32 implemented inline), and writes
 * assets/sprites/framemap.json.
 *
 * Frame file header lines (all optional except the legend contract):
 *   # timing: 120,120,200   per-frame durations in ms (overrides defaults)
 *   # loop: true|false       overrides the default loop table below
 *   # frames: N              informational
 *   Legend chars are fixed: .=transparent o=outline W=fur 1=furShade1
 *   2=furShade2 C=cream E=eyeNose T=tongue P=blush Y=effectYellow
 *   B=effectBlue Z=zzz
 *
 * framemap.json schema (the renderer codes against this — keep stable):
 * {
 *   "meta": { "tile": 32, "count": 96 },
 *   "animations": {
 *     "idle-sit": {
 *       "loop": true,
 *       "frames": [ { "x": 0, "y": 0, "w": 32, "h": 32, "durationMs": 250 } ]
 *     }
 *   },
 *   "effects": {
 *     "heart": { "loop": true, "frames": [ ...same frame shape... ] }
 *   }
 * }
 * - meta.tile: frame tile size in px (always 32). meta.count: total frames.
 * - animations: keyed by frame file name minus ".txt".
 * - effects: frame files named fx-*.txt, keyed by name minus "fx-" prefix.
 * - frames are packed left-to-right, top-to-bottom on a tile grid.
 * - durationMs: per-frame display time. loop: whether the animation repeats.
 *
 * Run: node scripts/build-sprites.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const SPRITES = path.join(ROOT, 'assets', 'sprites');
const FRAMES_DIR = path.join(SPRITES, 'frames');
const TILE = 32;

/* char -> palette.json key ('.' is transparent) */
const CHAR_TO_KEY = {
  o: 'outline', W: 'fur', 1: 'furShade1', 2: 'furShade2', C: 'cream',
  E: 'eyeNose', T: 'tongue', P: 'blush', Y: 'effectYellow', B: 'effectBlue',
  Z: 'zzz',
};

/* default per-frame timings (ms) when no `# timing:` header is present */
const DEFAULT_TIMING = {
  'idle-sit': 250, blink: [120, 120], 'tail-wag': 150,
  'walk-left': 120, 'walk-right': 120, sleep: 600, work: 140, hop: 130,
  'fx-exclaim': [150, 250],
};
const FALLBACK_TIMING = 180;

/* default looping; one-shot (false) animations are triggered, not ambient */
const DEFAULT_LOOP = {
  'idle-sit': true, blink: false, 'tail-wag': true, 'ear-twitch': false,
  'look-left': false, 'look-right': false, 'look-up': false, 'look-down': false,
  'walk-left': true, 'walk-right': true, sleep: true, wake: false, yawn: false,
  stretch: false, scratch: false, happy: false, 'pet-squint': false, hop: false,
  sad: true, think: true, work: true, 'alert-bark': false, 'drag-dangle': true,
  'drop-bounce': false, peek: true,
  sneeze: false, shake: false, 'tail-chase': false,
  'fx-heart': true, 'fx-sparkle': true, 'fx-ellipsis': true, 'fx-exclaim': false,
  'fx-zzz': true, 'fx-steam': true, 'fx-sweat': true,
};

function hexToRgba(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

/* minimal CRC32 (IEEE) for PNG chunks */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const parts = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG magic
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ];
  return Buffer.concat(parts);
}

function parseFrameFile(filePath) {
  const name = path.basename(filePath, '.txt');
  const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const headers = {};
  const frameChunks = [[]];
  for (const ln of raw.split('\n')) {
    if (ln.startsWith('#')) {
      const m = ln.match(/^#\s*([a-zA-Z-]+)\s*:\s*(.*)$/);
      if (m) headers[m[1].toLowerCase()] = m[2].trim();
      continue;
    }
    if (ln === '---FRAME---') { frameChunks.push([]); continue; }
    if (ln === '' ) continue;
    frameChunks[frameChunks.length - 1].push(ln);
  }
  const frames = frameChunks.filter(c => c.length > 0);
  if (frames.length === 0) throw new Error(name + ': no frames found');
  frames.forEach((rows, fi) => {
    if (rows.length !== TILE) throw new Error(name + ' frame ' + fi + ': ' + rows.length + ' rows, want 32');
    rows.forEach((row, ri) => {
      if (row.length !== TILE) throw new Error(name + ' frame ' + fi + ' row ' + ri + ': ' + row.length + ' chars, want 32');
      for (let ci = 0; ci < row.length; ci++) {
        const ch = row[ci];
        if (ch !== '.' && !(ch in CHAR_TO_KEY)) {
          throw new Error(name + ' frame ' + fi + ' row ' + ri + ' col ' + ci + ": unknown char '" + ch + "'");
        }
      }
    });
  });
  let timing = null;
  if (headers.timing) {
    timing = headers.timing.split(',').map(s => {
      const n = parseInt(s.trim(), 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(name + ': bad timing value "' + s + '"');
      return n;
    });
    if (timing.length !== frames.length) {
      throw new Error(name + ': timing has ' + timing.length + ' values but ' + frames.length + ' frames');
    }
  }
  let loop = null;
  if (headers.loop !== undefined) {
    if (headers.loop !== 'true' && headers.loop !== 'false') throw new Error(name + ': bad loop value');
    loop = headers.loop === 'true';
  }
  return { name, frames, timing, loop };
}

function resolveTiming(name, count, override) {
  if (override) return override;
  const d = DEFAULT_TIMING[name];
  if (Array.isArray(d)) return d;
  if (typeof d === 'number') return new Array(count).fill(d);
  return new Array(count).fill(FALLBACK_TIMING);
}

function main() {
  const palette = JSON.parse(fs.readFileSync(path.join(SPRITES, 'palette.json'), 'utf8'));
  const rgbaOf = {};
  for (const [ch, key] of Object.entries(CHAR_TO_KEY)) {
    if (!(key in palette)) throw new Error('palette.json missing key "' + key + '"');
    rgbaOf[ch] = hexToRgba(palette[key]);
  }

  const files = fs.readdirSync(FRAMES_DIR).filter(f => f.endsWith('.txt')).sort();
  if (files.length === 0) throw new Error('no frame files in ' + FRAMES_DIR);
  const parsed = files.map(f => parseFrameFile(path.join(FRAMES_DIR, f)));

  const total = parsed.reduce((n, p) => n + p.frames.length, 0);
  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);
  const sheetW = cols * TILE, sheetH = rows * TILE;
  const rgba = new Uint8ClampedArray(sheetW * sheetH * 4); // transparent by default

  const animations = {}, effects = {};
  let idx = 0;
  for (const p of parsed) {
    const isFx = p.name.startsWith('fx-');
    const key = isFx ? p.name.slice(3) : p.name;
    const target = isFx ? effects : animations;
    if (key in target) throw new Error('duplicate animation key "' + key + '"');
    const durations = resolveTiming(p.name, p.frames.length, p.timing);
    const loop = p.loop !== null ? p.loop : (DEFAULT_LOOP[p.name] !== undefined ? DEFAULT_LOOP[p.name] : true);
    const frames = [];
    p.frames.forEach((rowsArr, fi) => {
      const tx = (idx % cols) * TILE, ty = Math.floor(idx / cols) * TILE;
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const ch = rowsArr[y][x];
        if (ch === '.') continue;
        const [r, g, b, a] = rgbaOf[ch];
        const o = ((ty + y) * sheetW + (tx + x)) * 4;
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
      }
      frames.push({ x: tx, y: ty, w: TILE, h: TILE, durationMs: durations[fi] });
      idx++;
    });
    target[key] = { loop, frames };
  }

  fs.writeFileSync(path.join(SPRITES, 'spritesheet.png'), encodePng(sheetW, sheetH, rgba));
  const framemap = { meta: { tile: TILE, count: total }, animations, effects };
  fs.writeFileSync(path.join(SPRITES, 'framemap.json'), JSON.stringify(framemap, null, 2) + '\n');
  console.log('spritesheet.png ' + sheetW + 'x' + sheetH + ' (' + total + ' frames)');
  console.log('animations: ' + Object.keys(animations).length + ', effects: ' + Object.keys(effects).length);
}

main();
