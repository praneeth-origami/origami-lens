import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectLanguage, isParseableLanguage, type DetectedLanguage } from './repository-language.js';
import { isLikelyBinaryFile, isSensitiveFile } from './repository-file-safety.js';
import { parseAndExtract } from './repository-ast.js';
import { chunkSymbol, computeContentHash, type CodeChunkDraft } from './repository-chunker.js';
import type { DiscoveredFileEntry } from './repository-discovery.js';

/**
 * Line-number convention for every persisted symbol/chunk in this feature:
 * 1-based, inclusive start/end lines (matching the spec's own worked
 * example), 0-based start/end columns (Tree-sitter's own convention, which
 * matches most editors). Applied consistently by repository-ast.ts and
 * carried through unchanged by repository-chunker.ts — nothing in this file
 * re-derives or re-converts either.
 */

export type IndexedFileStatus =
  | 'INDEXED'
  | 'SKIPPED_BINARY'
  | 'SKIPPED_UNSUPPORTED_LANGUAGE'
  | 'SKIPPED_TOO_LARGE'
  | 'SKIPPED_IGNORED'
  | 'SKIPPED_SENSITIVE'
  | 'PARSE_ERROR';

export interface ProcessedFileResult {
  relativePath: string;
  language: DetectedLanguage;
  fileSizeBytes: number;
  contentHash?: string;
  status: IndexedFileStatus;
  error?: string;
  chunks: CodeChunkDraft[];
}

export interface ProcessFileLimits {
  maxFileSizeBytes: number;
}

/**
 * Conventionally-noise files that aren't secrets and aren't binary, but add
 * nothing useful to a code index — generated/vendored lockfiles and
 * minified bundles. Kept separate from Phase 2's directory-level ignore list
 * (that one is applied by iterateRepositoryFiles before a file is ever
 * reached here at all); this is a file-level equivalent for individual
 * filenames that can appear anywhere in the tree.
 */
const IGNORED_FILENAME_PATTERNS: RegExp[] = [
  /^package-lock\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
  /^Cargo\.lock$/i,
  /^poetry\.lock$/i,
  /^Gemfile\.lock$/i,
  /\.min\.(js|css)$/i,
];

export function isIgnoredFile(relativePath: string): boolean {
  const base = path.basename(relativePath);
  return IGNORED_FILENAME_PATTERNS.some((pattern) => pattern.test(base));
}

/** Never includes any part of the source file's own content — only a short, generic message. */
function sanitizeParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown parse error';
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * Processes exactly one discovered file end to end: safety checks first
 * (never reading a sensitive file's content, never reading past the size
 * limit), then binary detection, then — only for a genuinely text,
 * genuinely parseable file — Tree-sitter parsing, symbol extraction, and
 * chunking. Never throws for a bad/malformed source file: every failure
 * mode is reported back as a status on the returned result so the caller
 * (the index worker) can continue with the next file, which is what "one
 * malformed file must not fail the entire repository" requires.
 */
export async function processRepositoryFile(
  entry: DiscoveredFileEntry,
  context: { repositoryId: string; commitSha: string },
  limits: ProcessFileLimits,
): Promise<ProcessedFileResult> {
  const language = detectLanguage(entry.relativePath);
  const base: Pick<ProcessedFileResult, 'relativePath' | 'language'> = { relativePath: entry.relativePath, language };

  if (isIgnoredFile(entry.relativePath)) {
    return { ...base, fileSizeBytes: 0, status: 'SKIPPED_IGNORED', chunks: [] };
  }

  if (isSensitiveFile(entry.relativePath)) {
    return { ...base, fileSizeBytes: 0, status: 'SKIPPED_SENSITIVE', chunks: [] };
  }

  let sizeBytes: number;
  try {
    sizeBytes = fs.statSync(entry.absolutePath).size;
  } catch (error) {
    return { ...base, fileSizeBytes: 0, status: 'PARSE_ERROR', error: sanitizeParseError(error), chunks: [] };
  }

  if (sizeBytes > limits.maxFileSizeBytes) {
    return { ...base, fileSizeBytes: sizeBytes, status: 'SKIPPED_TOO_LARGE', chunks: [] };
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(entry.absolutePath);
  } catch (error) {
    return { ...base, fileSizeBytes: sizeBytes, status: 'PARSE_ERROR', error: sanitizeParseError(error), chunks: [] };
  }

  if (isLikelyBinaryFile(entry.relativePath, buffer)) {
    return { ...base, fileSizeBytes: sizeBytes, status: 'SKIPPED_BINARY', chunks: [] };
  }

  const source = buffer.toString('utf8');
  const contentHash = computeContentHash(source);

  if (!isParseableLanguage(language)) {
    return { ...base, fileSizeBytes: sizeBytes, contentHash, status: 'SKIPPED_UNSUPPORTED_LANGUAGE', chunks: [] };
  }

  try {
    const astResult = await parseAndExtract(language, source);
    if (!astResult) {
      return { ...base, fileSizeBytes: sizeBytes, contentHash, status: 'SKIPPED_UNSUPPORTED_LANGUAGE', chunks: [] };
    }

    const chunks = astResult.symbols.flatMap((symbol) =>
      chunkSymbol(symbol, { repositoryId: context.repositoryId, commitSha: context.commitSha, filePath: entry.relativePath, language }),
    );

    return { ...base, fileSizeBytes: sizeBytes, contentHash, status: 'INDEXED', chunks };
  } catch (error) {
    // Tree-sitter's own error-recovery means this is rare (see
    // repository-ast.ts) — reserved for a genuine parser exception, not an
    // ordinary syntax error in the source, which still parses successfully
    // with hasSyntaxError: true and is not treated as a failure.
    return { ...base, fileSizeBytes: sizeBytes, contentHash, status: 'PARSE_ERROR', error: sanitizeParseError(error), chunks: [] };
  }
}
