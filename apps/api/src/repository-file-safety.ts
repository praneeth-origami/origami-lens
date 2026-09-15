import * as path from 'node:path';

/**
 * Extensions that are never worth content-sniffing — matching any of these
 * is treated as binary immediately, without reading the file at all.
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.avif',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z', '.bz2', '.xz',
  '.mp4', '.mp3', '.mov', '.avi', '.webm', '.wav', '.flac', '.ogg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.jar', '.wasm',
  '.db', '.sqlite', '.sqlite3',
]);

/**
 * Fast, extension-based first pass. Deliberately not the only check (see
 * looksBinaryFromContent) — an unfamiliar or mislabeled extension must still
 * be caught by content sniffing rather than assumed to be text.
 */
export function hasKnownBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Content-based binary sniff — the same heuristic Git and most text tools
 * use: a NUL byte essentially never appears in legitimate UTF-8/ASCII source
 * text, but is common in binary formats. Only inspects a bounded prefix so
 * this stays cheap even for a large file the size-limit check let through.
 */
const SNIFF_BYTES = 8192;

export function looksBinaryFromContent(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, SNIFF_BYTES);
  for (let i = 0; i < length; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/** Combines the extension fast-path with content sniffing — "do not rely only on extensions." */
export function isLikelyBinaryFile(filePath: string, buffer: Buffer): boolean {
  return hasKnownBinaryExtension(filePath) || looksBinaryFromContent(buffer);
}

/**
 * Filenames that are never indexed regardless of content — matched
 * conservatively so this only catches unambiguous credential/secret files,
 * not merely secret-sounding source code. Content is never read for these:
 * the filename check happens before any fs.readFileSync.
 */
const SENSITIVE_FILENAME_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /^id_rsa(\.pub)?$/i,
  /^id_ed25519(\.pub)?$/i,
  /^id_dsa(\.pub)?$/i,
  /^id_ecdsa(\.pub)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^credentials(\.json)?$/i,
];

export function isSensitiveFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return SENSITIVE_FILENAME_PATTERNS.some((pattern) => pattern.test(base));
}
