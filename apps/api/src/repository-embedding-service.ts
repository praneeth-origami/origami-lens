import { scrubString } from '@origami/privacy';
import { AI_EMBED_MAX_INPUT_TOKENS } from './repository-embedding-provider.js';

export interface EmbeddableChunk {
  filePath: string;
  language: string;
  symbol: string;
  symbolType: string;
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * Deterministic, stable text built from a chunk's metadata + content — the
 * same chunk always produces exactly the same embedding input, with nothing
 * transient (no timestamps, job ids, or other metadata that doesn't affect
 * meaning) mixed in. scrubString (the same primitive services/ai-router's
 * /embed route also applies) strips anything JWT/Bearer-token/email/card-
 * shaped before this text is ever sent anywhere — repository source may
 * contain accidentally committed secrets even after Phase 3's sensitive-file
 * filtering, since that only excludes whole files by name, not content
 * within an otherwise-normal file.
 */
export function buildEmbeddingInput(chunk: EmbeddableChunk): string {
  const header = [
    `File: ${chunk.filePath}`,
    `Language: ${chunk.language}`,
    `Symbol: ${chunk.symbol}`,
    `Symbol Type: ${chunk.symbolType}`,
    `Lines: ${chunk.startLine}-${chunk.endLine}`,
  ].join('\n');
  return scrubString(`${header}\n\n${chunk.content}`);
}

/**
 * No real tokenizer for BGE-M3 is wired into this project — this is a
 * conservative, documented approximation (~4 characters per token, a common
 * rough estimate for code/English text) used only to decide whether a chunk
 * is safe to send at all, not to bill or budget tokens precisely.
 */
const APPROX_CHARS_PER_TOKEN = 4;

export function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

/** A chunk this large is skipped (SKIPPED_TOO_LARGE) rather than sent — protects against a pathological chunk consuming the model's entire context window or failing outright. */
export function exceedsMaxEmbeddingInputTokens(text: string): boolean {
  return approximateTokenCount(text) > AI_EMBED_MAX_INPUT_TOKENS;
}
