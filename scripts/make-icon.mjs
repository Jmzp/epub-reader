// Generates the 1024×1024 source icon (an open book with a curling page) without extra deps.
// Usage: node scripts/make-icon.mjs && npx tauri icon app-icon.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const N = 1024;
const SS = 3; // supersampling per axis
const px = new Float32Array(N * N * 4);

const bg = [0.478, 0.294, 0.071]; // #7a4b12
const paper = [0.984, 0.973, 0.945];
const shade = [0.86, 0.83, 0.77];
const ink = [0.62, 0.56, 0.47];

function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function sample(x, y) {
  if (!roundRect(x, y, 64, 64, 960, 960, 200)) return null;
  let c = bg;
  // Left page: slightly skewed quad.
  const spine = 512;
  const top = (t) => 300 - 40 * Math.sin(Math.PI * t);
  if (x >= 210 && x <= spine) {
    const t = (spine - x) / (spine - 210);
    if (y >= top(t) && y <= 740 - 20 * Math.sin(Math.PI * t)) {
      c = paper;
      for (let k = 0; k < 6; k++) {
        const ly = top(t) + 70 + k * 58;
        if (Math.abs(y - ly) < 9 && x > 250 && x < spine - 40) c = ink;
      }
      if (x > spine - 28) c = shade;
    }
  }
  // Right page with a curled corner.
  if (x > spine && x <= 814) {
    const t = (x - spine) / (814 - spine);
    const yTop = top(t);
    const yBot = 740 - 20 * Math.sin(Math.PI * t);
    const curl = (x - 640) + (y - 560) > 190; // cut-off corner
    if (y >= yTop && y <= yBot && !curl) {
      c = paper;
      for (let k = 0; k < 6; k++) {
        const ly = yTop + 70 + k * 58;
        if (Math.abs(y - ly) < 9 && x > spine + 40 && x < 774 && (x - 640) + (ly - 560) < 150) c = ink;
      }
      if (x < spine + 28) c = shade;
    }
    // The curl itself: triangle folded back.
    const u = (x - 640) + (y - 560);
    if (u > 190 && u < 260 && x < 814 && y < yBot && x > 640) c = shade;
  }
  return c;
}

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
      }
    }
    const i = (y * N + x) * 4;
    const n = SS * SS;
    px[i] = a ? r / a : 0; px[i + 1] = a ? g / a : 0; px[i + 2] = a ? b / a : 0; px[i + 3] = a / n;
  }
}

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N * 4; x++) raw[y * (N * 4 + 1) + 1 + x] = Math.round(px[y * N * 4 + x] * 255);
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync('app-icon.png', Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]));
console.log('wrote app-icon.png');
