// Generates the app icons (PNG + SVG) with no dependencies.
// Design: a strip of adding-machine tape on banknote green.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const GREEN = [15, 61, 46];
const PAPER = [255, 255, 255];
const MINT = [126, 196, 160];
const INK = [15, 61, 46];

// Shapes in a 0..1 unit square. pad shrinks the art for maskable icons.
function shade(x, y, { pad = 0, rounded = true }) {
  const r = 0.2;
  if (rounded) {
    const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null; // transparent corner
  }
  const s = 1 - 2 * pad;
  const u = (x - pad) / s, v = (y - pad) / s;
  // tape: x 0.28..0.72, y 0.16..0.80 with a zigzag bottom edge
  const tl = 0.28, tr = 0.72, top = 0.16, bot = 0.8;
  const tooth = 0.055;
  const phase = ((u - tl) / tooth) % 1;
  const zig = bot - Math.abs(phase - 0.5) * tooth * 1.2;
  if (u >= tl && u <= tr && v >= top && v <= zig) {
    const line = (y0, x1) => v >= y0 && v <= y0 + 0.035 && u >= 0.34 && u <= x1;
    if (line(0.27, 0.66) || line(0.37, 0.58) || line(0.47, 0.62)) return MINT;
    if (v >= 0.6 && v <= 0.645 && u >= 0.34 && u <= 0.66) return INK; // total rule
    return PAPER;
  }
  return GREEN;
}

function png(size, opts) {
  const ss = 4; // supersampling
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, opts);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
      }
      const n = ss * ss, o = y * (size * 4 + 1) + 1 + x * 4;
      const cov = a / 255 || 1;
      raw[o] = Math.round(r / cov); raw[o + 1] = Math.round(g / cov); raw[o + 2] = Math.round(b / cov); raw[o + 3] = Math.round(a / n);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return c ^ 0xffffffff; }

mkdirSync('app/icons', { recursive: true });
writeFileSync('app/icons/icon-192.png', png(192, {}));
writeFileSync('app/icons/icon-512.png', png(512, {}));
writeFileSync('app/icons/maskable-512.png', png(512, { pad: 0.12, rounded: false }));

const zig = Array.from({ length: 9 }, (_, i) => `${28 + i * 5.5},${i % 2 ? 76.7 : 80}`).join(' ');
writeFileSync('app/icons/icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="20" fill="#0f3d2e"/>
<polygon fill="#fff" points="28,16 72,16 72,80 ${zig.split(' ').reverse().join(' ')}"/>
<rect x="34" y="27" width="32" height="3.5" fill="#7ec4a0"/><rect x="34" y="37" width="24" height="3.5" fill="#7ec4a0"/>
<rect x="34" y="47" width="28" height="3.5" fill="#7ec4a0"/><rect x="34" y="60" width="32" height="4.5" fill="#0f3d2e"/>
</svg>
`);
console.log('icons written');
