// Generates build/icon.png (256px) and build/icon.ico (16-256px): violet rounded square with white waveform bars.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BARS = [0.30, 0.55, 0.85, 0.50, 0.95, 0.65, 0.35];

function render(N) {
  const SS = 3; // supersampling for smooth edges
  const px = Buffer.alloc(N * N * 4);
  const r = N * 0.22;
  const inRound = (x, y) => {
    const cx = Math.min(Math.max(x, r), N - r), cy = Math.min(Math.max(y, r), N - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const bw = N * 0.078, gap = N * 0.047, total = BARS.length * bw + (BARS.length - 1) * gap, x0 = (N - total) / 2;
  const bar = (x, y) => {
    const i = Math.floor((x - x0) / (bw + gap));
    if (i < 0 || i >= BARS.length || (x - x0) - i * (bw + gap) > bw) return false;
    return Math.abs(y - N / 2) <= (BARS[i] * N * 0.58) / 2;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let a = 0, wh = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
      if (inRound(fx, fy)) { a++; if (bar(fx, fy)) wh++; }
    }
    const n = SS * SS, o = (y * N + x) * 4;
    const t = y / N;
    const bg = [Math.round(150 - 30 * t), Math.round(128 - 28 * t), Math.round(255 - 30 * t)]; // #806cf5-ish gradient
    const k = a ? wh / a : 0;
    px[o] = Math.round(bg[0] + (255 - bg[0]) * k);
    px[o + 1] = Math.round(bg[1] + (255 - bg[1]) * k);
    px[o + 2] = Math.round(bg[2] + (255 - bg[2]) * k);
    px[o + 3] = Math.round((a / n) * 255);
  }
  return px;
}

function png(N, px) {
  const raw = Buffer.alloc((N * 4 + 1) * N);
  for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Classic BMP (DIB) frame: older shell loaders (e.g. Start menu search) cannot read PNG-compressed icon frames below 256px.
function dib(N, px) {
  const maskRow = Math.ceil(N / 32) * 4;
  const h = Buffer.alloc(40); h.writeUInt32LE(40, 0); h.writeInt32LE(N, 4); h.writeInt32LE(N * 2, 8); h.writeUInt16LE(1, 12); h.writeUInt16LE(32, 14);
  h.writeUInt32LE(N * N * 4 + maskRow * N, 20);
  const body = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const s = ((N - 1 - y) * N + x) * 4, d = (y * N + x) * 4;
    body[d] = px[s + 2]; body[d + 1] = px[s + 1]; body[d + 2] = px[s]; body[d + 3] = px[s + 3];
  }
  return Buffer.concat([h, body, Buffer.alloc(maskRow * N)]);
}
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((n) => png(n, render(n)));
const frames = sizes.map((n) => (n === 256 ? pngs[sizes.length - 1] : dib(n, render(n))));
const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = 6 + sizes.length * 16;
const dir = sizes.map((n, i) => {
  const e = Buffer.alloc(16);
  e[0] = n === 256 ? 0 : n; e[1] = n === 256 ? 0 : n; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(frames[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += frames[i].length;
  return e;
});
const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), pngs[sizes.length - 1]);
const ico = Buffer.concat([head, ...dir, ...frames]);
fs.writeFileSync(path.join(out, 'icon.ico'), ico);
// Tauri copies (window/exe icon + the image shown while dragging a sample out)
const tauriIcons = path.join(__dirname, '..', 'src-tauri', 'icons');
fs.mkdirSync(tauriIcons, { recursive: true });
fs.writeFileSync(path.join(tauriIcons, 'icon.png'), pngs[sizes.length - 1]);
fs.writeFileSync(path.join(tauriIcons, 'icon.ico'), ico);
fs.writeFileSync(path.join(tauriIcons, 'drag.png'), pngs[sizes.indexOf(32)]);
console.log('wrote icon.png and icon.ico in', out, 'and', tauriIcons);
