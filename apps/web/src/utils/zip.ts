/**
 * Minimal dependency-free ZIP writer (STORE method — no compression).
 * Used by "Download Component" to package multi-file generated components
 * without pulling in a new npm dependency for something this small.
 */

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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class ByteWriter {
  private chunks: number[] = [];

  u16(value: number) {
    this.chunks.push(value & 0xff, (value >>> 8) & 0xff);
  }

  u32(value: number) {
    this.chunks.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }

  bytes(data: Uint8Array) {
    for (let i = 0; i < data.length; i++) this.chunks.push(data[i]);
  }

  toUint8Array(): Uint8Array<ArrayBuffer> {
    const buffer = new ArrayBuffer(this.chunks.length);
    const view = new Uint8Array(buffer);
    view.set(this.chunks);
    return view;
  }

  get length(): number {
    return this.chunks.length;
  }
}

export interface ZipEntry {
  path: string;
  content: string;
}

export function buildZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const writer = new ByteWriter();
  const centralEntries: { nameBytes: Uint8Array; crc: number; size: number; offset: number }[] = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const dataBytes = encoder.encode(entry.content);
    const crc = crc32(dataBytes);
    const offset = writer.length;

    writer.u32(0x04034b50);
    writer.u16(20); // version needed
    writer.u16(0); // flags
    writer.u16(0); // method: store
    writer.u16(0); // mod time
    writer.u16(0); // mod date
    writer.u32(crc);
    writer.u32(dataBytes.length); // compressed size
    writer.u32(dataBytes.length); // uncompressed size
    writer.u16(nameBytes.length);
    writer.u16(0); // extra length
    writer.bytes(nameBytes);
    writer.bytes(dataBytes);

    centralEntries.push({ nameBytes, crc, size: dataBytes.length, offset });
  }

  const centralStart = writer.length;
  for (const entry of centralEntries) {
    writer.u32(0x02014b50);
    writer.u16(20); // version made by
    writer.u16(20); // version needed
    writer.u16(0); // flags
    writer.u16(0); // method
    writer.u16(0); // mod time
    writer.u16(0); // mod date
    writer.u32(entry.crc);
    writer.u32(entry.size);
    writer.u32(entry.size);
    writer.u16(entry.nameBytes.length);
    writer.u16(0); // extra length
    writer.u16(0); // comment length
    writer.u16(0); // disk number
    writer.u16(0); // internal attrs
    writer.u32(0); // external attrs
    writer.u32(entry.offset);
    writer.bytes(entry.nameBytes);
  }
  const centralSize = writer.length - centralStart;

  writer.u32(0x06054b50);
  writer.u16(0); // disk number
  writer.u16(0); // disk with central dir
  writer.u16(centralEntries.length);
  writer.u16(centralEntries.length);
  writer.u32(centralSize);
  writer.u32(centralStart);
  writer.u16(0); // comment length

  return new Blob([writer.toUint8Array()], { type: 'application/zip' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
