import { parseAndExtract } from './repository-ast.js';
import { GRAMMAR_WASM_FILE, type DetectedLanguage } from './repository-language.js';
import type { RepositoryFixSyntaxStatus } from '@origami/contracts';

/**
 * The Phase 10-discovered "line-number grounding gap" fix: an AI-reported
 * startLine/endLine is NEVER used to locate where a hunk applies. Only
 * `oldText`, matched verbatim against the real, current file content, is
 * authoritative. Exactly one occurrence is required — zero is a hallucinated
 * hunk, more than one is ambiguous and this deliberately never guesses which
 * occurrence was meant (see the Phase 11 report's grounding section).
 *
 * Phase 14 addition: matching is CRLF/LF-aware. Phase 11's live testing
 * found that a real AI-generated `oldText` can use plain `\n` while the
 * real file (checked out on Windows, or simply authored with CRLF) uses
 * `\r\n` for the exact same line — content that is semantically identical
 * was being rejected as OLD_TEXT_NOT_FOUND purely over a line-ending
 * *encoding* difference. The fix below normalizes ONLY line-ending bytes
 * for the purpose of locating a match, then maps the match back onto the
 * REAL, un-normalized file content before ever slicing/replacing anything
 * — so the exact-match guarantee over actual text content (words,
 * indentation, punctuation) is completely unchanged; only the `\r`
 * bookkeeping is treated as insignificant. See normalizeLineEndings/
 * mapNormalizedRangeToOriginal below for the exact mechanism.
 */
export type LocateOldTextResult =
  | { ok: true; matchIndex: number; matchEndIndex: number; actualStartLine: number; actualEndLine: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'ambiguous'; occurrenceCount: number };

/** 1-based line number of the character at `index` within `content`. Counting `\n` bytes (rather than `\r\n` as a unit) is correct for LF, CRLF, and mixed-ending content alike — a CRLF line ending always still contains exactly one `\n`, so it is never double- or under-counted. */
function lineNumberAtIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Collapses `\r\n` and lone `\r` to `\n` — comparison/matching only, NEVER
 * used to overwrite a file's actual on-disk bytes (see applyHunkToContent,
 * which always slices the ORIGINAL, un-normalized content). Returns both
 * the normalized string and a same-length index map back to the original
 * string's offsets, so a match found in normalized space can be translated
 * back to an EXACT byte range in the real content — never an approximation,
 * never a broadened region.
 *
 * Exported so every other "does oldText exist in this known content?"
 * grounding check (e.g. repository-finding-fix-service.ts's
 * validateFindingFixProposal) can reuse this exact line-ending collapse
 * instead of re-implementing it — a real CRLF-indexed file compared against
 * an LF-authored AI proposal must never be rejected as ungrounded purely
 * over line-ending bytes, here or anywhere else this comparison is made.
 */
export function normalizeLineEndings(text: string): { normalized: string; originalIndex: number[] } {
  let normalized = '';
  const originalIndex: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\r' && text[i + 1] === '\n') {
      normalized += '\n';
      originalIndex.push(i);
      i += 2;
    } else if (text[i] === '\r') {
      normalized += '\n';
      originalIndex.push(i);
      i += 1;
    } else {
      normalized += text[i];
      originalIndex.push(i);
      i += 1;
    }
  }
  originalIndex.push(text.length); // sentinel: maps a normalized end-of-match index one-past-the-last-char to the real end offset
  return { normalized, originalIndex };
}

function countOccurrences(haystack: string, needle: string): number[] {
  const indexes: number[] = [];
  let cursor = 0;
  while (true) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) break;
    indexes.push(found);
    cursor = found + 1; // allow overlapping matches to be detected, not just skipped past
  }
  return indexes;
}

/**
 * Locates `oldText` in `content` with line-ending-insensitive comparison
 * (see the module comment) but byte-exact comparison of everything else —
 * indentation, casing, punctuation, and every non-line-ending character
 * must still match exactly. `matchIndex`/`matchEndIndex` are always real
 * offsets into the ORIGINAL `content` string, never the normalized one.
 */
export function locateOldText(content: string, oldText: string): LocateOldTextResult {
  const { normalized: normalizedContent, originalIndex } = normalizeLineEndings(content);
  const normalizedOldText = normalizeLineEndings(oldText).normalized;

  const occurrences = countOccurrences(normalizedContent, normalizedOldText);
  if (occurrences.length === 0) return { ok: false, reason: 'not_found' };
  if (occurrences.length > 1) return { ok: false, reason: 'ambiguous', occurrenceCount: occurrences.length };

  const normalizedMatchIndex = occurrences[0];
  const normalizedMatchEndIndex = normalizedMatchIndex + normalizedOldText.length;
  const matchIndex = originalIndex[normalizedMatchIndex];
  const matchEndIndex = originalIndex[normalizedMatchEndIndex];

  const actualStartLine = lineNumberAtIndex(content, matchIndex);
  const actualEndLine = lineNumberAtIndex(content, Math.max(matchIndex, matchEndIndex - 1));
  return { ok: true, matchIndex, matchEndIndex, actualStartLine, actualEndLine };
}

type LineEndingStyle = 'LF' | 'CRLF';

/**
 * The file's own dominant line-ending convention — detected once from its
 * REAL current content, never assumed. A tie (or a file with no newlines
 * at all) deterministically resolves to LF, the safe default. Exported for
 * direct testing; also usable by callers that want to report a file's
 * convention without applying a hunk.
 */
export function detectDominantLineEnding(content: string): LineEndingStyle {
  const crlfCount = (content.match(/\r\n/g) ?? []).length;
  const bareLfCount = (content.match(/(?<!\r)\n/g) ?? []).length;
  return crlfCount > bareLfCount ? 'CRLF' : 'LF';
}

/** Re-renders `text` in the requested line-ending style — always via a normalize-then-expand round trip, so mixed/inconsistent input is deterministically resolved to one consistent style. */
export function applyLineEndingStyle(text: string, style: LineEndingStyle): string {
  const normalized = normalizeLineEndings(text).normalized;
  return style === 'CRLF' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

export type ApplyHunkResult =
  | { ok: true; content: string; actualStartLine: number; actualEndLine: number }
  | { ok: false; reason: 'not_found' | 'ambiguous' };

/**
 * Replaces exactly the ONE located occurrence of `oldText` with `newText`
 * — never a broad/global search-and-replace, and never anything derived
 * from the AI's reported line numbers. The removed span is the exact
 * original bytes at [matchIndex, matchEndIndex) (whatever line-ending
 * style they happen to use) — every other byte in the file, including
 * every other line ending, is left completely untouched. `newText` is
 * re-rendered to match the FILE's own dominant line-ending style before
 * insertion, so an AI-generated `\n`-only replacement never introduces a
 * foreign line-ending style into a CRLF file (or vice versa) — the file
 * is never rewritten wholesale to normalize endings, only the newly
 * inserted text is conformed to what was already there.
 */
export function applyHunkToContent(content: string, hunk: { oldText: string; newText: string }): ApplyHunkResult {
  const located = locateOldText(content, hunk.oldText);
  if (!located.ok) return { ok: false, reason: located.reason };

  const fileStyle = detectDominantLineEnding(content);
  const styledNewText = applyLineEndingStyle(hunk.newText, fileStyle);

  const newContent = content.slice(0, located.matchIndex) + styledNewText + content.slice(located.matchEndIndex);
  return { ok: true, content: newContent, actualStartLine: located.actualStartLine, actualEndLine: located.actualEndLine };
}

const PARSEABLE_LANGUAGES = new Set<string>(Object.keys(GRAMMAR_WASM_FILE));

/**
 * Reuses Phase 3's Tree-sitter infrastructure (repository-ast.ts) unchanged
 * — never a second parser implementation. `html` and any language with no
 * wired grammar returns UNSUPPORTED, never a fabricated VALID/INVALID
 * verdict (see the Phase 11 report's syntax-validation section for why this
 * distinction matters).
 */
export async function validateSyntax(language: string, content: string): Promise<RepositoryFixSyntaxStatus> {
  if (!PARSEABLE_LANGUAGES.has(language)) return 'UNSUPPORTED';
  const result = await parseAndExtract(language as DetectedLanguage, content);
  if (!result) return 'UNSUPPORTED';
  return result.hasSyntaxError ? 'INVALID' : 'VALID';
}
