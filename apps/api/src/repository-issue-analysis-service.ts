import type { RepositoryIssue, RepositoryIssueAnalysis } from '@origami/contracts';
import { isSensitiveFile } from './repository-file-safety.js';
import { IssueAnalysisProviderError, type EvidenceChunkInput, type IssueAnalysisProvider } from './repository-issue-analysis-provider.js';
import type { InsertCodeChunkInput } from './db/repository-index-repository.js';

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

/** Bounded evidence set — never the whole repository. Sized similarly to REPOSITORY_SEARCH_CANDIDATE_K's spirit but smaller: an issue analysis reasons over ONE issue's worth of context, not a broad search result set. */
export const REPOSITORY_ISSUE_MAX_EVIDENCE_CHUNKS = envInt('REPOSITORY_ISSUE_MAX_EVIDENCE_CHUNKS', 8);
/** ~2000 tokens at a conservative 4-chars/token estimate — the same budget class as AI_EMBED_MAX_INPUT_TOKENS's reasoning, comfortably inside any chat model's context alongside the issue text and system prompt. */
export const REPOSITORY_ISSUE_MAX_EVIDENCE_CHARS = envInt('REPOSITORY_ISSUE_MAX_EVIDENCE_CHARS', 8_000);

export class IssueAnalysisError extends Error {
  constructor(message: string, public readonly code: 'ANALYSIS_PROVIDER_UNAVAILABLE' | 'ANALYSIS_TIMEOUT' | 'ANALYSIS_FAILED') {
    super(message);
    this.name = 'IssueAnalysisError';
  }
}

export interface SearchEvidenceCandidate {
  filePath: string;
  language: string;
  symbol: string;
  symbolType: string;
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * Best-effort semantic-search evidence enhancement — a thin function seam
 * (not a direct dependency on repository-search-service.ts's exact store/
 * provider types) so this service stays simple to test. The real wiring
 * (apps/api/src/workers/repository-issue-analysis-worker.ts) supplies a
 * closure backed by the REAL searchRepository() pipeline (Phase 4 BGE-M3
 * embeddings + Phase 5 pgvector + Phase 6 reranker) when the repository has
 * embeddings ready; any failure (no embeddings yet, reranker down, etc.) is
 * swallowed by the caller and analysis proceeds with direct evidence only —
 * semantic search is an enhancement here, never a hard dependency the way
 * it is for Phase 5's own search feature.
 */
export type SearchForEvidence = (repositoryId: string, query: string, limit: number) => Promise<SearchEvidenceCandidate[]>;

/**
 * Deterministic evidence gathering: chunks directly matching the issue's
 * own filePath/symbol (always available whenever the repository is
 * indexed) are always included first — these are the most reliably
 * relevant, since they are exactly what the user pointed at. A repository-
 * wide issue (no filePath) or additional context beyond the exact symbol
 * relies entirely on the optional search enhancement.
 */
export function gatherDirectEvidence(issue: Pick<RepositoryIssue, 'filePath' | 'symbol'>, chunks: InsertCodeChunkInput[]): InsertCodeChunkInput[] {
  if (!issue.filePath && !issue.symbol) return [];
  return chunks.filter((c) => {
    if (isSensitiveFile(c.filePath)) return false;
    if (issue.filePath && c.filePath !== issue.filePath) return false;
    if (issue.symbol && c.symbol !== issue.symbol) return false;
    return true;
  });
}

function chunkKey(chunk: { filePath: string; symbol: string; startLine: number }): string {
  return `${chunk.filePath}:${chunk.symbol}:${chunk.startLine}`;
}

/** Merges direct + search-derived evidence, dedupes, and enforces both REPOSITORY_ISSUE_MAX_EVIDENCE_CHUNKS and REPOSITORY_ISSUE_MAX_EVIDENCE_CHARS — direct evidence always wins a spot over search results when the budget is tight. */
export function boundEvidence(direct: EvidenceChunkInput[], search: EvidenceChunkInput[]): EvidenceChunkInput[] {
  const seen = new Set<string>();
  const bounded: EvidenceChunkInput[] = [];
  let totalChars = 0;

  for (const chunk of [...direct, ...search]) {
    if (isSensitiveFile(chunk.filePath)) continue;
    const key = chunkKey(chunk);
    if (seen.has(key)) continue;
    if (bounded.length >= REPOSITORY_ISSUE_MAX_EVIDENCE_CHUNKS) break;
    if (totalChars + chunk.content.length > REPOSITORY_ISSUE_MAX_EVIDENCE_CHARS) continue;
    seen.add(key);
    bounded.push(chunk);
    totalChars += chunk.content.length;
  }
  return bounded;
}

function toEvidenceChunkInput(chunk: InsertCodeChunkInput): EvidenceChunkInput {
  return { filePath: chunk.filePath, language: chunk.language, symbol: chunk.symbol, symbolType: chunk.symbolType, startLine: chunk.startLine, endLine: chunk.endLine, content: chunk.content };
}

export interface RunIssueAnalysisDeps {
  provider: IssueAnalysisProvider;
  searchForEvidence?: SearchForEvidence;
}

export interface RunIssueAnalysisResult {
  summary: string;
  rootCause: string;
  confidence: RepositoryIssueAnalysis['confidence'];
  affectedFiles: string[];
  affectedSymbols: string[];
  reasoning: string;
  recommendedFix: string;
  validationPlan: string;
  model: string;
  evidenceChunkCount: number;
}

/**
 * Orchestrates evidence gathering + the AI analysis call for one issue.
 * Never sends the whole repository — only the bounded evidence set built
 * above. Any provider failure is re-thrown as IssueAnalysisError with a
 * stable code the worker/route layer maps to an HTTP status, matching
 * repository-search-service.ts's SearchError convention.
 */
export async function runIssueAnalysis(
  issue: Pick<RepositoryIssue, 'title' | 'description' | 'filePath' | 'symbol' | 'lineStart' | 'lineEnd'>,
  repositoryId: string,
  indexedChunks: InsertCodeChunkInput[],
  deps: RunIssueAnalysisDeps,
  signal?: AbortSignal,
): Promise<RunIssueAnalysisResult> {
  const directEvidence = gatherDirectEvidence(issue, indexedChunks).map(toEvidenceChunkInput);

  let searchEvidence: EvidenceChunkInput[] = [];
  if (deps.searchForEvidence) {
    try {
      const query = [issue.title, issue.description].filter(Boolean).join(' — ');
      const results = await deps.searchForEvidence(repositoryId, query, REPOSITORY_ISSUE_MAX_EVIDENCE_CHUNKS);
      searchEvidence = results.map((r) => ({ filePath: r.filePath, language: r.language, symbol: r.symbol, symbolType: r.symbolType, startLine: r.startLine, endLine: r.endLine, content: r.content }));
    } catch {
      // Best-effort enhancement only — see SearchForEvidence's doc comment.
      // Analysis proceeds with direct evidence alone.
    }
  }

  const evidence = boundEvidence(directEvidence, searchEvidence);

  try {
    const result = await deps.provider.analyze(
      { title: issue.title, description: issue.description, filePath: issue.filePath, symbol: issue.symbol, lineStart: issue.lineStart, lineEnd: issue.lineEnd, evidence },
      signal,
    );
    return { ...result, evidenceChunkCount: evidence.length };
  } catch (error) {
    if (error instanceof IssueAnalysisProviderError) {
      throw new IssueAnalysisError(error.message, error.category);
    }
    throw new IssueAnalysisError('Issue analysis failed unexpectedly.', 'ANALYSIS_FAILED');
  }
}
