import type { Issue, RepositoryFixProposalErrorCode, RepositoryFixProposalFileChange, RepositoryFixProposalHunk, RepositoryFixProposalSource } from '@origami/contracts';
import { SearchError, searchRepository, type RepositorySearchStores, type SearchProviderDeps } from './repository-search-service.js';
import { buildFindingFixContext, buildFindingSearchQuery, summarizeFindingEvidence, type FindingSummary } from './repository-fix-context.js';
import { isSensitiveFile } from './repository-file-safety.js';
import { isRepositoryPathSafe, normalizeRepositoryPath } from './repository-path-safety.js';
import { FindingFixProviderError, type FindingFixProvider, type FindingFixProviderChange } from './repository-finding-fix-provider.js';
import type { UnifiedRepositoryIndexStore } from './unified-repository-index-store.js';
import type { InsertCodeChunkInput, InsertIndexFileInput } from './db/repository-index-repository.js';
import { normalizeLineEndings } from './repository-fix-validation.js';

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

/** Scan findings (visual/accessibility/functional issues) are typically localized to one component/stylesheet — a lower default than Phase 8's repository-issue fix proposals (5 files), biasing toward the "smallest reasonable change" principle. */
export const AI_FINDING_FIX_MAX_FILES = envInt('AI_FINDING_FIX_MAX_FILES', 3);
export const AI_FINDING_FIX_MAX_HUNKS_PER_FILE = envInt('AI_FINDING_FIX_MAX_HUNKS_PER_FILE', 5);
export const AI_FINDING_FIX_MAX_PROPOSAL_BYTES = envInt('AI_FINDING_FIX_MAX_PROPOSAL_BYTES', 20_000);
/** How many top reranked chunks are requested from the reused search pipeline — independent of Phase 9's own AI_REPOSITORY_QA_MAX_RESULT_CHUNKS. */
export const AI_FINDING_FIX_MAX_RESULT_CHUNKS = envInt('AI_FINDING_FIX_MAX_RESULT_CHUNKS', 10);

const MAX_FINDING_DESCRIPTION_CHARS = 1_500;

export class FindingFixError extends Error {
  constructor(message: string, public readonly code: RepositoryFixProposalErrorCode) {
    super(message);
    this.name = 'FindingFixError';
  }
}

/** Maps every SearchError code Phase 5/9 can throw onto RepositoryFixProposalErrorCode — the same reuse discipline as Phase 9's mapSearchErrorCode: never re-implements validation/embedding/vector-search/degraded-mode logic, only relabels the shared failure taxonomy. */
function mapSearchErrorCode(code: string): RepositoryFixProposalErrorCode {
  switch (code) {
    case 'REPOSITORY_NOT_FOUND':
    case 'REPOSITORY_ACCESS_DENIED':
    case 'REPOSITORY_NOT_READY':
    case 'EMBEDDINGS_NOT_READY':
    case 'EMBEDDING_PROVIDER_UNAVAILABLE':
    case 'EMBEDDING_TIMEOUT':
    case 'VECTOR_SEARCH_FAILED':
      return code as RepositoryFixProposalErrorCode;
    default:
      // SEARCH_QUERY_INVALID can't happen here — buildFindingSearchQuery
      // always derives a non-empty, bounded query from a validated finding,
      // never from unchecked user input. RERANKER_UNAVAILABLE/RERANKER_TIMEOUT
      // never reach here either — searchRepository() degrades internally.
      return 'FIX_PROPOSAL_FAILED';
  }
}

/**
 * Turns a persisted Issue (website-scan finding) into the bounded
 * FindingSummary repository-fix-context.ts expects — deterministic,
 * server-controlled, never accepts a client-supplied fake finding (see
 * repository-finding-fix-service.ts's caller, which always loads this from
 * the scan store, never from the request body).
 */
export function toFindingSummary(issue: Issue): FindingSummary {
  const description = [issue.problem, issue.cause, issue.impact, issue.suggestedFix]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join(' ');
  return {
    title: issue.title,
    severity: issue.severity,
    category: issue.category,
    description: description.length > MAX_FINDING_DESCRIPTION_CHARS ? `${description.slice(0, MAX_FINDING_DESCRIPTION_CHARS)}…` : description,
    evidence: summarizeFindingEvidence(issue.evidence as Record<string, unknown> | undefined),
  };
}

export interface FindingFixStores extends RepositorySearchStores {
  indexStore: Pick<UnifiedRepositoryIndexStore, 'getChunksForJobAsync' | 'getFilesForJobAsync' | 'getLatestForCommitAsync'>;
}

export interface FindingFixProviderDeps extends SearchProviderDeps {
  fixProvider: FindingFixProvider;
}

export interface ValidatedFindingHunk {
  startLine: number;
  endLine: number;
  oldText: string;
  newText: string;
}

export interface ValidatedFindingChange {
  filePath: string;
  language: string;
  hunks: ValidatedFindingHunk[];
}

interface ValidationOk {
  ok: true;
  changes: ValidatedFindingChange[];
}
interface ValidationFailure {
  ok: false;
  error: string;
}

/**
 * Static validation only — never runs any repository code, never applies
 * anything to any filesystem. Mirrors Phase 8's repository-fix-service.ts
 * validateFixProposal() checklist, adapted for the structured-hunk shape
 * this task uses instead of unified-diff text (see the Phase 10 report's
 * proposal-validation section for the full checklist).
 */
export function validateFindingFixProposal(
  changes: FindingFixProviderChange[],
  indexedFiles: InsertIndexFileInput[],
  indexedChunks: InsertCodeChunkInput[],
): ValidationOk | ValidationFailure {
  if (changes.length === 0) {
    return { ok: false, error: 'The proposal reported status PROPOSED but contains no file changes.' };
  }
  if (changes.length > AI_FINDING_FIX_MAX_FILES) {
    return { ok: false, error: `The proposal changes ${changes.length} files, exceeding the maximum of ${AI_FINDING_FIX_MAX_FILES}.` };
  }

  const proposalBytes = Buffer.byteLength(JSON.stringify(changes), 'utf8');
  if (proposalBytes > AI_FINDING_FIX_MAX_PROPOSAL_BYTES) {
    return { ok: false, error: `The proposal is ${proposalBytes} bytes, exceeding the maximum of ${AI_FINDING_FIX_MAX_PROPOSAL_BYTES}.` };
  }

  const filesByPath = new Map(indexedFiles.map((f) => [f.filePath, f]));
  const chunksByPath = new Map<string, InsertCodeChunkInput[]>();
  for (const chunk of indexedChunks) {
    const list = chunksByPath.get(chunk.filePath) ?? [];
    list.push(chunk);
    chunksByPath.set(chunk.filePath, list);
  }

  const validated: ValidatedFindingChange[] = [];

  for (const change of changes) {
    if (typeof change.filePath !== 'string' || !change.filePath.trim()) {
      return { ok: false, error: 'A proposed file change is missing a filePath.' };
    }
    const filePath = normalizeRepositoryPath(change.filePath);

    if (!isRepositoryPathSafe(filePath)) {
      return { ok: false, error: `Path "${filePath}" is not a safe relative path (absolute paths and ../ traversal are rejected).` };
    }
    if (isSensitiveFile(filePath)) {
      return { ok: false, error: `Path "${filePath}" refers to a sensitive file and cannot be modified.` };
    }

    const indexedFile = filesByPath.get(filePath);
    if (!indexedFile || indexedFile.status !== 'INDEXED') {
      return { ok: false, error: `Path "${filePath}" was not found in the indexed commit.` };
    }

    const rawHunks = change.hunks;
    if (!Array.isArray(rawHunks) || rawHunks.length === 0) {
      return { ok: false, error: `Path "${filePath}" has no proposed hunks.` };
    }
    if (rawHunks.length > AI_FINDING_FIX_MAX_HUNKS_PER_FILE) {
      return { ok: false, error: `Path "${filePath}" has ${rawHunks.length} hunks, exceeding the maximum of ${AI_FINDING_FIX_MAX_HUNKS_PER_FILE}.` };
    }

    const chunksForFile = chunksByPath.get(filePath) ?? [];
    const knownContent = chunksForFile.map((c) => c.content).join('\n');
    // Grounding must be line-ending-insensitive: the indexed content reflects
    // whatever the file's real bytes were at clone/checkout time (CRLF on a
    // machine/repo where git normalizes line endings on checkout), while an
    // AI-generated oldText is essentially always LF-only. Normalizing only
    // \r\n/\r -> \n on both sides before comparing (the same collapse
    // repository-fix-validation.ts's locateOldText already uses at apply
    // time) means a real, byte-identical-apart-from-line-endings match is
    // never rejected as "ungrounded" — every other character (indentation,
    // punctuation, wording) still must match exactly.
    const normalizedKnownContent = normalizeLineEndings(knownContent).normalized;

    const validatedHunks: ValidatedFindingHunk[] = [];
    for (const hunk of rawHunks) {
      const startLine = Number(hunk.startLine);
      const endLine = Number(hunk.endLine);
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
        return { ok: false, error: `Path "${filePath}" has a hunk with an invalid line range.` };
      }
      if (typeof hunk.oldText !== 'string' || !hunk.oldText.trim()) {
        return { ok: false, error: `Path "${filePath}" has a hunk missing oldText — oldText must be the actual existing code being replaced.` };
      }
      if (typeof hunk.newText !== 'string') {
        return { ok: false, error: `Path "${filePath}" has a hunk missing newText.` };
      }
      if (hunk.oldText === hunk.newText) {
        return { ok: false, error: `Path "${filePath}" has a hunk where oldText and newText are identical — not a real change.` };
      }
      // Grounding check: oldText must correspond to real, already-indexed
      // content for this file — the same hallucination guard as Phase 8's
      // validateFixProposal, skipped only when we have no chunk content at
      // all for this file (e.g. a CSS/config file Tree-sitter never
      // chunked at symbol granularity) — a documented limitation, not a
      // silent bypass.
      const normalizedOldText = normalizeLineEndings(hunk.oldText).normalized.trim();
      if (chunksForFile.length > 0 && !normalizedKnownContent.includes(normalizedOldText)) {
        return { ok: false, error: `Path "${filePath}" has a hunk whose oldText does not match the indexed content — proposal rejected as ungrounded.` };
      }
      validatedHunks.push({ startLine, endLine, oldText: hunk.oldText, newText: hunk.newText });
    }

    validated.push({ filePath, language: typeof change.language === 'string' ? change.language : indexedFile.language, hunks: validatedHunks });
  }

  return { ok: true, changes: validated };
}

function logFindingFixCompleted(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: 'repository_finding_fix_completed', ...fields }));
}

export interface FindingFixRequestParams {
  repositoryId: string;
  ownerId?: string;
  instruction?: unknown;
}

const MAX_INSTRUCTION_LENGTH = 500;

function validateInstruction(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new FindingFixError('instruction must be a string when supplied.', 'FINDING_INVALID');
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_INSTRUCTION_LENGTH) {
    throw new FindingFixError(`instruction must be ${MAX_INSTRUCTION_LENGTH} characters or fewer.`, 'FINDING_INVALID');
  }
  return trimmed;
}

export interface FindingFixResponse {
  repositoryId: string;
  findingId: string;
  commitSha: string;
  status: 'PROPOSED' | 'INSUFFICIENT_EVIDENCE';
  summary: string;
  reasoning: string;
  changes: RepositoryFixProposalFileChange[];
  sources: RepositoryFixProposalSource[];
  candidateCount: number;
  reranked: boolean;
  model?: string;
}

function toHunkContract(hunk: ValidatedFindingHunk): RepositoryFixProposalHunk {
  return { startLine: hunk.startLine, endLine: hunk.endLine, oldText: hunk.oldText, newText: hunk.newText };
}

/**
 * Orchestrates: load the finding from the PERSISTED scan store (never
 * trusts a client-supplied finding) -> derive a bounded search query ->
 * reuse searchRepository() unchanged (Phase 5/6/9: validation, embedding,
 * pgvector, reranking, degraded mode, sensitive-file filtering) -> fetch
 * full chunk content -> build bounded finding+code context -> call the
 * Phase 10 AI provider -> statically validate the returned proposal.
 * Never re-implements retrieval; only adds finding-specific context
 * building, the LLM call, and hunk-level proposal validation on top.
 */
export async function proposeFindingFix(
  repository: { id: string; ownerId?: string; status: string } | undefined,
  finding: Issue | undefined,
  stores: FindingFixStores,
  params: FindingFixRequestParams,
  deps: FindingFixProviderDeps,
  signal?: AbortSignal,
): Promise<FindingFixResponse> {
  const startedAt = Date.now();
  const instruction = validateInstruction(params.instruction);

  if (!finding) {
    throw new FindingFixError('Finding not found.', 'FINDING_NOT_FOUND');
  }

  const findingSummary = toFindingSummary(finding);
  const searchQuery = buildFindingSearchQuery(finding);

  let searchDurationMs: number;
  let searchResponse;
  {
    const t0 = Date.now();
    try {
      searchResponse = await searchRepository(
        repository,
        stores,
        { repositoryId: params.repositoryId, ownerId: params.ownerId, query: searchQuery, limit: AI_FINDING_FIX_MAX_RESULT_CHUNKS },
        { embeddingProvider: deps.embeddingProvider, rerankerProvider: deps.rerankerProvider },
        signal,
      );
    } catch (error) {
      if (error instanceof SearchError) throw new FindingFixError(error.message, mapSearchErrorCode(error.code));
      throw new FindingFixError('Repository search failed unexpectedly.', 'FIX_PROPOSAL_FAILED');
    }
    searchDurationMs = Date.now() - t0;
  }

  if (searchResponse.results.length === 0) {
    logFindingFixCompleted({
      repositoryId: repository!.id, findingId: finding.id, commitSha: searchResponse.commitSha, candidateCount: 0,
      searchDurationMs, contextBuildDurationMs: 0, llmDurationMs: 0, totalDurationMs: Date.now() - startedAt, reranked: false, status: 'INSUFFICIENT_EVIDENCE',
    });
    return {
      repositoryId: repository!.id, findingId: finding.id, commitSha: searchResponse.commitSha, status: 'INSUFFICIENT_EVIDENCE',
      summary: 'The indexed repository context does not contain enough evidence to propose a safe fix.', reasoning: 'No relevant repository code was retrieved for this finding.',
      changes: [], sources: [], candidateCount: 0, reranked: false,
    };
  }

  let contextBuildDurationMs: number;
  let contextText: string;
  let sources: RepositoryFixProposalSource[];
  let indexedFiles: InsertIndexFileInput[];
  let indexedChunks: InsertCodeChunkInput[];
  {
    const t0 = Date.now();
    const indexJob = await stores.indexStore.getLatestForCommitAsync(repository!.id, searchResponse.commitSha);
    indexedFiles = indexJob ? await stores.indexStore.getFilesForJobAsync(indexJob.jobId) : [];
    indexedChunks = indexJob ? await stores.indexStore.getChunksForJobAsync(indexJob.jobId) : [];
    const fullContentByChunkId = new Map(indexedChunks.map((c) => [c.id, c.content]));

    const contextChunks = searchResponse.results.map((r) => ({
      filePath: r.filePath, language: r.language, symbol: r.symbol, symbolType: r.symbolType,
      startLine: r.startLine, endLine: r.endLine, content: fullContentByChunkId.get(r.chunkId) ?? r.content ?? '',
    }));
    const built = buildFindingFixContext(findingSummary, contextChunks);
    contextText = built.contextText;
    sources = built.includedChunks.map((c) => ({ filePath: c.filePath, symbol: c.symbol, symbolType: c.symbolType, startLine: c.startLine, endLine: c.endLine }));
    contextBuildDurationMs = Date.now() - t0;
  }

  let aiResult;
  let llmDurationMs: number;
  {
    const t0 = Date.now();
    try {
      aiResult = await deps.fixProvider.proposeFix({ contextText, instruction }, signal);
    } catch (error) {
      if (error instanceof FindingFixProviderError) throw new FindingFixError(error.message, error.category);
      throw new FindingFixError('Finding fix-proposal failed unexpectedly.', 'FIX_PROPOSAL_FAILED');
    }
    llmDurationMs = Date.now() - t0;
  }

  let responseStatus: 'PROPOSED' | 'INSUFFICIENT_EVIDENCE' = aiResult.status;
  let changes: RepositoryFixProposalFileChange[] = [];
  let summary = aiResult.summary;

  if (aiResult.status === 'PROPOSED') {
    const validation = validateFindingFixProposal(aiResult.changes, indexedFiles, indexedChunks);
    if (!validation.ok) {
      throw new FindingFixError(validation.error, 'PROPOSAL_INVALID');
    }
    changes = validation.changes.map((c) => ({ filePath: c.filePath, language: c.language, hunks: c.hunks.map(toHunkContract) }));
  } else {
    // Model itself reported INSUFFICIENT_EVIDENCE — no changes to validate,
    // and sources are cleared too: nothing was actually used to ground a
    // fix, so nothing should be cited as if it were.
    sources = [];
    summary = summary || 'The indexed repository context does not contain enough evidence to propose a safe fix.';
    responseStatus = 'INSUFFICIENT_EVIDENCE';
  }

  const totalDurationMs = Date.now() - startedAt;
  logFindingFixCompleted({
    repositoryId: repository!.id, findingId: finding.id, commitSha: searchResponse.commitSha, candidateCount: searchResponse.candidateCount,
    searchDurationMs, contextBuildDurationMs, llmDurationMs, totalDurationMs, reranked: searchResponse.reranked, status: responseStatus, fileCount: changes.length,
  });

  return {
    repositoryId: repository!.id, findingId: finding.id, commitSha: searchResponse.commitSha, status: responseStatus,
    summary, reasoning: aiResult.reasoning, changes, sources, candidateCount: searchResponse.candidateCount,
    reranked: searchResponse.reranked, model: aiResult.model,
  };
}
