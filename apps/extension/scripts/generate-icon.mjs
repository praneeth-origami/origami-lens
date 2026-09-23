/**
 * Renders the real Origami Lens brand icon (brand-icon-source.png — the
 * actual provided artwork, not a hand-drawn approximation) at a given size,
 * for the extension's manifest icons/action.default_icon. Decoded/resized/
 * re-encoded via png-image.mjs's hand-rolled PNG codec (no image-processing
 * dependency) — see that file's doc comment.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { decodePng, encodePng, resizeRgba } from './png-image.mjs';

const SOURCE_PATH = path.join(import.meta.dirname, 'brand-icon-source.png');

export function renderIconPng(size) {
  const source = decodePng(readFileSync(SOURCE_PATH));
  const resized = resizeRgba(source.pixels, source.width, source.height, size, size);
  return encodePng(size, size, resized);
}
