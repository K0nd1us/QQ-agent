// 一次性生成应用图标 assets/icon.png（64x64，蓝底圆角方块 + 白色气泡）。
// 运行：node scripts/gen-icon.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'assets', 'icon.png');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const W = 64, H = 64;
const BLUE = [91, 140, 255];
const WHITE = [255, 255, 255];

function pixel(x, y) {
  // 圆角方块（SDF）
  const rad = 14;
  const qx = Math.abs(x - (W - 1) / 2) - (W / 2 - 0.5 - rad);
  const qy = Math.abs(y - (H - 1) / 2) - (H / 2 - 0.5 - rad);
  const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
  if (dist > 0) return [0, 0, 0, 0];
  // 白色气泡：圆 + 小尾巴
  const inCircle = Math.hypot(x - 32, y - 30) <= 14;
  const inTail = y >= 40 && y <= 52 && x >= (32 - (y - 40) * 0.55 - 6) && x <= (32 + (y - 40) * 0.55 - 6);
  if (inCircle || inTail) return [...WHITE, 255];
  return [...BLUE, 255];
}

const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const row = y * (1 + W * 4);
  raw[row] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const [r, g, b, a] = pixel(x, y);
    const o = row + 1 + x * 4;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`已生成 ${OUT}（${png.length} 字节）`);
