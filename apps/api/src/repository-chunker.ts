import { createHash } from 'node:crypto';
import { envInt } from './repository-clone-service.js';
import type { ExtractedSymbol } from './repository-ast.js';

/** A single function/class/etc. fits in one chunk as long as it stays under both limits — most real-world symbols do. */
export const REPOSITORY_INDEX_MAX_CHUNK_BYTES = envInt('REPOSITORY_INDEX_MAX_CHUNK_BYTES', 4000);
export const REPOSITORY_INDEX_MAX_CHUNK_LINES = envInt('REPOSITORY_INDEX_MAX_CHUNK_LINES', 200);

export interface CodeChunkDraft {
  /** Deterministic identity for this logical chunk — see computeChunkKey. Not a database primary key (see the Phase 3 report's chunk-id design note). */
  chunkKey: string;
  filePath: string;
  language: string;
  symbol: string;
  symbolType: string;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  isExported: boolean;
  content: string;
  /** sha256 of `content` — deterministic content identity, independent of chunkKey (see computeChunkKey). */
  contentHash: string;
}

/** Deterministic content identity — never a timestamp or random value, so re-indexing unchanged content always produces the same hash. */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Deterministic logical identity for a chunk, derived only from where it is
 * (repository + commit + file + symbol + line range + split index) — never a
 * random UUID. Re-indexing the same commit twice reproduces the same key for
 * the same logical chunk, which is what "the same commit indexed twice
 * should produce the same logical chunk identity" requires. This is
 * intentionally a separate concept from any database UUID primary key the
 * storage layer uses (see repository-index-repository.ts) and from
 * contentHash (this identifies "this location", contentHash identifies
 * "this exact text" — the two diverge if a symbol's body changes but its
 * name/position happens to be reused, or vice versa).
 */
export function computeChunkKey(params: {
  repositoryId: string;
  commitSha: string;
  filePath: string;
  symbolType: string;
  symbol: string;
  startLine: number;
  endLine: number;
  chunkIndex: number;
}): string {
  const canonical = [
    params.repositoryId,
    params.commitSha,
    params.filePath,
    params.symbolType,
    params.symbol,
    params.startLine,
    params.endLine,
    params.chunkIndex,
  ].join(':');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Splits `content` into line-bounded groups that each fit within both
 * limits. Splitting only ever happens at a '\n' boundary, so a UTF-8
 * multi-byte character (which never contains a byte equal to the ASCII
 * newline byte) can never be split — this holds regardless of chunk size
 * configuration.
 */
function splitLinesIntoGroups(lines: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for the newline joining it back
    const wouldExceed = current.length > 0 && (current.length >= REPOSITORY_INDEX_MAX_CHUNK_LINES || currentBytes + lineBytes > REPOSITORY_INDEX_MAX_CHUNK_BYTES);
    if (wouldExceed) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(line);
    currentBytes += lineBytes;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Converts one extracted symbol into one or more persistable chunks. A
 * symbol that already fits the configured limits becomes exactly one chunk
 * preserving its full metadata (rule 1). An oversized symbol is split
 * deterministically along line boundaries into ordered sub-chunks that each
 * keep the same symbol/symbolType/parentSymbol/isExported metadata but their
 * own line range (rules 2-5) — nested symbols (e.g. a class's methods) are
 * already separate ExtractedSymbol entries from repository-ast.ts, so in
 * practice this line-based fallback is only reached for a single oversized
 * unit that has no further useful substructure (e.g. one very long function
 * body), which is exactly the case the spec's "otherwise split by line
 * boundaries" rule describes.
 */
export function chunkSymbol(symbol: ExtractedSymbol, context: { repositoryId: string; commitSha: string; filePath: string; language: string }): CodeChunkDraft[] {
  const byteLength = Buffer.byteLength(symbol.content, 'utf8');
  const lineCount = symbol.endLine - symbol.startLine + 1;

  const draft = (content: string, startLine: number, endLine: number, startColumn: number, endColumn: number, chunkIndex: number): CodeChunkDraft => ({
    chunkKey: computeChunkKey({
      repositoryId: context.repositoryId,
      commitSha: context.commitSha,
      filePath: context.filePath,
      symbolType: symbol.symbolType,
      symbol: symbol.symbol,
      startLine,
      endLine,
      chunkIndex,
    }),
    filePath: context.filePath,
    language: context.language,
    symbol: symbol.symbol,
    symbolType: symbol.symbolType,
    parentSymbol: symbol.parentSymbol,
    startLine,
    endLine,
    startColumn,
    endColumn,
    isExported: symbol.isExported,
    content,
    contentHash: computeContentHash(content),
  });

  if (byteLength <= REPOSITORY_INDEX_MAX_CHUNK_BYTES && lineCount <= REPOSITORY_INDEX_MAX_CHUNK_LINES) {
    return [draft(symbol.content, symbol.startLine, symbol.endLine, symbol.startColumn, symbol.endColumn, 0)];
  }

  const lines = symbol.content.split('\n');
  const groups = splitLinesIntoGroups(lines);
  const chunks: CodeChunkDraft[] = [];
  let lineCursor = symbol.startLine;

  groups.forEach((group, index) => {
    const startLine = lineCursor;
    const endLine = lineCursor + group.length - 1;
    const isFirst = index === 0;
    const isLast = index === groups.length - 1;
    chunks.push(
      draft(
        group.join('\n'),
        startLine,
        endLine,
        isFirst ? symbol.startColumn : 0,
        isLast ? symbol.endColumn : 0,
        index,
      ),
    );
    lineCursor = endLine + 1;
  });

  return chunks;
}
