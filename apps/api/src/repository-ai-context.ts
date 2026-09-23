import { scrubString } from '@origami/privacy';

function envInt(name: string, defaultValue: number, minValue = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    console.error(JSON.stringify({ event: 'invalid_repository_config', name, providedValue: raw, minValue, fallback: defaultValue }));
    return defaultValue;
  }
  return parsed;
}

/**
 * Total LLM context budget across all included chunks — the Phase 8 report
 * already established the "own dedicated context/evidence budget, sized
 * like AI_EMBED_MAX_INPUT_TOKENS's reasoning" pattern; this is that same
 * pattern applied to Q&A, which typically wants a bit more material than a
 * single-issue analysis since a good answer may need to reference several
 * related symbols across files (~3000 tokens at a conservative 4 chars/token).
 */
export const AI_REPOSITORY_QA_MAX_CONTEXT_CHARS = envInt('AI_REPOSITORY_QA_MAX_CONTEXT_CHARS', 12_000);
/** A single pathologically large chunk must never consume the whole budget on its own — bounds any one chunk's content before it is ever assembled into context. */
export const AI_REPOSITORY_QA_MAX_CHUNK_CHARS = envInt('AI_REPOSITORY_QA_MAX_CHUNK_CHARS', 4_000);

export interface RepositoryContextChunk {
  filePath: string;
  language: string;
  symbol: string;
  symbolType: string;
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * The exact format requested by the Phase 9 spec — deliberately distinct
 * from repository-embedding-service.ts's buildEmbeddingInput() (which omits
 * the "Code:" label and serves a different purpose: embedding input, not
 * LLM-readable context). Both independently call scrubString on the raw
 * chunk content, since accidentally-committed secrets can appear inside an
 * otherwise ordinary, non-sensitive file's content — Phase 3's filename-based
 * sensitive-file exclusion does not catch that.
 */
export function formatContextBlock(chunk: RepositoryContextChunk): string {
  const content = chunk.content.length > AI_REPOSITORY_QA_MAX_CHUNK_CHARS
    ? `${chunk.content.slice(0, AI_REPOSITORY_QA_MAX_CHUNK_CHARS)}…`
    : chunk.content;
  return [
    `File: ${chunk.filePath}`,
    `Language: ${chunk.language}`,
    `Symbol: ${chunk.symbol}`,
    `Symbol Type: ${chunk.symbolType}`,
    `Lines: ${chunk.startLine}-${chunk.endLine}`,
    '',
    'Code:',
    scrubString(content),
  ].join('\n');
}

export interface RepositoryQaContext {
  contextText: string;
  /** Exactly the chunks whose complete metadata/content made it into contextText — never a chunk that was dropped for budget reasons, and never a partially-truncated chunk beyond AI_REPOSITORY_QA_MAX_CHUNK_CHARS above. */
  includedChunks: RepositoryContextChunk[];
}

/**
 * Assembles bounded, deterministic LLM context from already-ranked chunks
 * (highest relevance first — the caller is responsible for that ordering,
 * see repository-ai-service.ts, which passes chunks in the exact order
 * Phase 5/6's search+reranking pipeline produced). Never sends the entire
 * repository — only as many complete chunks as fit AI_REPOSITORY_QA_MAX_CONTEXT_CHARS.
 *
 * The single highest-ranked chunk is always included even if it alone
 * exceeds the remaining budget — an answer must never be starved of all
 * evidence merely because the most relevant chunk happens to be large
 * (it is still individually bounded by AI_REPOSITORY_QA_MAX_CHUNK_CHARS via
 * formatContextBlock). Every chunk after the first is included only if it
 * fits completely — a chunk is never cut mid-way to fit the remaining
 * budget; once one doesn't fit, iteration stops (lower-ranked chunks are
 * skipped entirely, never inserted out of rank order to fill remaining
 * space).
 *
 * `maxContextChars` defaults to AI_REPOSITORY_QA_MAX_CONTEXT_CHARS but can
 * be overridden — added for Phase 10's repository-fix-context.ts, which
 * reuses this exact bounding algorithm for a differently-sized budget
 * (AI_REPOSITORY_FIX_MAX_CONTEXT_CHARS) rather than reimplementing it.
 * Omitting the argument leaves Phase 9's own call site's behavior unchanged.
 */
export function buildRepositoryQaContext(rankedChunks: RepositoryContextChunk[], maxContextChars: number = AI_REPOSITORY_QA_MAX_CONTEXT_CHARS): RepositoryQaContext {
  const includedChunks: RepositoryContextChunk[] = [];
  const blocks: string[] = [];
  let totalChars = 0;

  for (const chunk of rankedChunks) {
    const block = formatContextBlock(chunk);
    if (includedChunks.length > 0 && totalChars + block.length > maxContextChars) {
      break;
    }
    includedChunks.push(chunk);
    blocks.push(block);
    totalChars += block.length;
  }

  return { contextText: blocks.join('\n\n---\n\n'), includedChunks };
}
