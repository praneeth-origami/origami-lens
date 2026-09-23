/**
 * A small hand-rolled PNG decoder/resizer/encoder — no image-processing
 * dependency (sharp/canvas/etc.), matching this codebase's existing
 * preference for hand-rolling a well-documented format when adding a
 * library isn't warranted (see apps/api/src/github-app-auth.ts's hand-rolled
 * JWT signer). Only supports what this project's actual source asset is:
 * 8-bit, non-interlaced, RGBA (colorType 6) or RGB (colorType 2) PNG — an
 * unsupported input throws rather than silently misdecoding.
 */
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decodes an 8-bit RGB/RGBA, non-interlaced PNG into { width, height, pixels } — `pixels` is always a tightly-packed RGBA Buffer (width*height*4 bytes), regardless of whether the source had an alpha channel. */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file');

  let offset = 8;
  let width; let height; let bitDepth; let colorType; let interlace;
  const idatParts = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatParts.push(data);
    }

    offset += 8 + length + 4; // length + type + data + crc
  }

  if (width === undefined) throw new Error('Missing IHDR chunk');
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth} (only 8-bit is supported)`);
  if (colorType !== 6 && colorType !== 2) throw new Error(`Unsupported PNG color type: ${colorType} (only RGB/RGBA is supported)`);
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported');

  const srcBpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idatParts));
  const stride = width * srcBpp;
  const pixels = Buffer.alloc(width * height * 4);
  let prevRow = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride);
    const filterType = raw[rowStart];
    const row = Buffer.alloc(stride);

    for (let x = 0; x < stride; x++) {
      const filt = raw[rowStart + 1 + x];
      const a = x >= srcBpp ? row[x - srcBpp] : 0;
      const b = prevRow[x];
      const c = x >= srcBpp ? prevRow[x - srcBpp] : 0;

      let value;
      switch (filterType) {
        case 0: value = filt; break;
        case 1: value = filt + a; break;
        case 2: value = filt + b; break;
        case 3: value = filt + Math.floor((a + b) / 2); break;
        case 4: value = filt + paeth(a, b, c); break;
        default: throw new Error(`Unsupported PNG filter type: ${filterType}`);
      }
      row[x] = value & 0xff;
    }

    for (let px = 0; px < width; px++) {
      const srcIdx = px * srcBpp;
      const dstIdx = (y * width + px) * 4;
      pixels[dstIdx] = row[srcIdx];
      pixels[dstIdx + 1] = row[srcIdx + 1];
      pixels[dstIdx + 2] = row[srcIdx + 2];
      pixels[dstIdx + 3] = srcBpp === 4 ? row[srcIdx + 3] : 255;
    }

    prevRow = row;
  }

  return { width, height, pixels };
}

/** Bilinear resize with alpha-premultiplied sampling (avoids dark/light fringing at transparent/opaque edges — a plain per-channel lerp would blend a fully-transparent pixel's arbitrary RGB into the visible result). */
export function resizeRgba(pixels, srcWidth, srcHeight, dstWidth, dstHeight) {
  const out = Buffer.alloc(dstWidth * dstHeight * 4);

  const sampleAt = (sx, sy) => {
    const x0 = Math.max(0, Math.min(srcWidth - 1, Math.floor(sx)));
    const y0 = Math.max(0, Math.min(srcHeight - 1, Math.floor(sy)));
    const x1 = Math.min(srcWidth - 1, x0 + 1);
    const y1 = Math.min(srcHeight - 1, y0 + 1);
    const fx = sx - x0;
    const fy = sy - y0;

    const idx = (x, y) => (y * srcWidth + x) * 4;
    const corners = [idx(x0, y0), idx(x1, y0), idx(x0, y1), idx(x1, y1)];
    const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];

    let r = 0; let g = 0; let b = 0; let a = 0;
    for (let i = 0; i < 4; i++) {
      const p = corners[i];
      const w = weights[i];
      const alpha = pixels[p + 3] / 255;
      r += pixels[p] * alpha * w;
      g += pixels[p + 1] * alpha * w;
      b += pixels[p + 2] * alpha * w;
      a += pixels[p + 3] * w;
    }
    return a > 0 ? [r / (a / 255), g / (a / 255), b / (a / 255), a] : [0, 0, 0, 0];
  };

  for (let dy = 0; dy < dstHeight; dy++) {
    for (let dx = 0; dx < dstWidth; dx++) {
      const sx = ((dx + 0.5) * srcWidth) / dstWidth - 0.5;
      const sy = ((dy + 0.5) * srcHeight) / dstHeight - 0.5;
      const [r, g, b, a] = sampleAt(sx, sy);
      const outIdx = (dy * dstWidth + dx) * 4;
      out[outIdx] = Math.round(Math.max(0, Math.min(255, r)));
      out[outIdx + 1] = Math.round(Math.max(0, Math.min(255, g)));
      out[outIdx + 2] = Math.round(Math.max(0, Math.min(255, b)));
      out[outIdx + 3] = Math.round(Math.max(0, Math.min(255, a)));
    }
  }

  return out;
}

/** Encodes a tightly-packed RGBA buffer as a standard 8-bit RGBA PNG. */
export function encodePng(width, height, pixels) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter type: None
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
