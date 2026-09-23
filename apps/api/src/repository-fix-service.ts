import type { RepositoryFixChangeType, RepositoryIssue } from '@origami/contracts';
import { isSensitiveFile } from './repository-file-safety.js';
import { isRepositoryPathSafe, normalizeRepositoryPath } from './repository-path-safety.js';
import { FixProposalProviderError, type FixProposalProvider, type FixProposalProviderFile } from './repository-fix-provider.js';
import { boundEvidence, gatherDirectEvidence, type SearchForEvidence } from './repository-issue-analysis-service.js';
import type { EvidenceChunkInput, IssueAnalysisProviderResult } from './repository-issue-analysis-provider.js';
import type { InsertCodeChunkInput, InsertIndexFileInput } from './db/repository-index-repository.js';

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

/** Phase 8 "strongly prefers MODIFIED files" and a small, reviewable change — never an unbounded multi-file rewrite. */
export const REPOSITORY_FIX_MAX_FILES = envInt('REPOSITORY_FIX_MAX_FILES', 5);
/** ~20KB of diff text comfortably covers several small-to-medium file changes while staying far short of "the AI just rewrote half the repository." */
export const REPOSITORY_FIX_MAX_DIFF_BYTES = envInt('REPOSITORY_FIX_MAX_DIFF_BYTES', 20_000);

export class FixProposalError extends Error {
  constructor(message: string, public readonly code: 'PROPOSAL_PROVIDER_UNAVAILABLE' | 'PROPOSAL_TIMEOUT' | 'PROPOSAL_INVALID' | 'PROPOSAL_FAILED') {
    super(message);
    this.name = 'FixProposalError';
  }
}

export interface ValidatedFileChange {
  filePath: string;
  changeType: RepositoryFixChangeType;
  oldContentHash?: string;
  diff: string;
}

interface ParsedFileDiff {
  additions: number;
  deletions: number;
  removedLines: string[];
}

/**
 * Minimal unified-diff structural parser for ONE file's diff text (each
 * proposal file carries its own scoped diff — see FixProposalProviderFile).
 * Deliberately does not attempt to actually apply the patch (no post-image
 * is ever materialized in Phase 8 — see RepositoryFixFileChange.newContentHash's
 * doc comment); it only needs enough structure to (a) confirm this is
 * recognizably a unified diff and (b) extract removed-line content for the
 * grounding check in validateFixProposal below.
 */
export function parseFileDiff(diffText: string): ParsedFileDiff | null {
  if (typeof diffText !== 'string' || !diffText.trim()) return null;
  const lines = diffText.split('\n');
  let sawHunk = false;
  let additions = 0;
  let deletions = 0;
  const removedLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('@@')) {
      sawHunk = true;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('-')) {
      deletions += 1;
      removedLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      additions += 1;
    }
  }

  if (!sawHunk) return null;
  return { additions, deletions, removedLines };
}

export interface ValidateFixProposalResult {
  ok: true;
  files: ValidatedFileChange[];
}
export interface ValidateFixProposalFailure {
  ok: false;
  error: string;
}

/**
 * Static validation only — never runs any repository code, never applies
 * the patch to any filesystem, never executes package.json scripts,
 * Makefiles, or shell scripts. Every check here is either string/path
 * inspection or a comparison against already-trusted, already-indexed
 * database records (see the Phase 8 report's diff-validation section for
 * the full checklist this implements).
 */
export function validateFixProposal(
  proposalFiles: FixProposalProviderFile[],
  indexedFiles: InsertIndexFileInput[],
  indexedChunks: InsertCodeChunkInput[],
): ValidateFixProposalResult | ValidateFixProposalFailure {
  if (proposalFiles.length === 0) {
    return { ok: false, error: 'The proposal contains no file changes.' };
  }
  if (proposalFiles.length > REPOSITORY_FIX_MAX_FILES) {
    return { ok: false, error: `The proposal changes ${proposalFiles.length} files, exceeding the maximum of ${REPOSITORY_FIX_MAX_FILES}.` };
  }
  const totalDiffBytes = proposalFiles.reduce((sum, f) => sum + Buffer.byteLength(f.diff ?? '', 'utf8'), 0);
  if (totalDiffBytes > REPOSITORY_FIX_MAX_DIFF_BYTES) {
    return { ok: false, error: `The proposed diff is ${totalDiffBytes} bytes, exceeding the maximum of ${REPOSITORY_FIX_MAX_DIFF_BYTES}.` };
  }

  const filesByPath = new Map(indexedFiles.map((f) => [f.filePath, f]));
  const chunksByPath = new Map<string, InsertCodeChunkInput[]>();
  for (const chunk of indexedChunks) {
    const list = chunksByPath.get(chunk.filePath) ?? [];
    list.push(chunk);
    chunksByPath.set(chunk.filePath, list);
  }

  const validated: ValidatedFileChange[] = [];

  for (const file of proposalFiles) {
    if (typeof file.filePath !== 'string' || !file.filePath.trim()) {
      return { ok: false, error: 'A proposed file change is missing a filePath.' };
    }
    const filePath = normalizeRepositoryPath(file.filePath);

    if (!isRepositoryPathSafe(filePath)) {
      return { ok: false, error: `Path "${filePath}" is not a safe relative path (absolute paths and ../ traversal are rejected).` };
    }
    if (isSensitiveFile(filePath)) {
      return { ok: false, error: `Path "${filePath}" refers to a sensitive file and cannot be modified.` };
    }

    const parsed = parseFileDiff(file.diff);
    if (!parsed) {
      return { ok: false, error: `The diff for "${filePath}" is not a syntactically valid unified diff.` };
    }

    const changeType: RepositoryFixChangeType = file.changeType ?? 'MODIFIED';
    const indexedFile = filesByPath.get(filePath);

    let oldContentHash: string | undefined;
    if (changeType === 'ADDED') {
      if (indexedFile) {
        return { ok: false, error: `Path "${filePath}" already exists in the indexed repository and cannot be ADDED.` };
      }
    } else {
      // MODIFIED or DELETED both require the file to genuinely exist —
      // "changed files are inside repository root" and "referenced files
      // exist" both apply equally to a claimed deletion.
      if (!indexedFile || indexedFile.status !== 'INDEXED') {
        return { ok: false, error: `Path "${filePath}" was not found in the indexed commit.` };
      }
      oldContentHash = indexedFile.contentHash;

      // Grounding check: every removed line must correspond to real,
      // already-indexed content for this file — a diff whose "before"
      // state doesn't match anything we actually indexed is treated as
      // hallucinated, not a valid patch. Skipped only when we have no
      // chunk content at all for this file (e.g. a config/JSON file
      // Tree-sitter never chunked) — a documented limitation, not a
      // silent bypass: such files simply fall back to path/existence/
      // sensitivity checks only.
      const chunksForFile = chunksByPath.get(filePath) ?? [];
      if (chunksForFile.length > 0) {
        const knownContent = chunksForFile.map((c) => c.content).join('\n');
        const ungroundedLine = parsed.removedLines.find((line) => line.trim().length > 0 && !knownContent.includes(line.trim()));
        if (ungroundedLine !== undefined) {
          return { ok: false, error: `The diff for "${filePath}" removes a line that does not match the indexed content — proposal rejected as ungrounded.` };
        }
      }
    }

    validated.push({ filePath, changeType, oldContentHash, diff: file.diff });
  }

  return { ok: true, files: validated };
}

export interface ProposeFixDeps {
  provider: FixProposalProvider;
  searchForEvidence?: SearchForEvidence;
}

export interface ProposeFixResult {
  summary: string;
  filesChanged: ValidatedFileChange[];
  proposedDiff: string;
  model: string;
}

/**
 * Full orchestration: commit-match check -> evidence gathering (same
 * pattern as repository-issue-analysis-service.ts) -> AI call -> static
 * validation. Throws FixProposalError('PROPOSAL_INVALID', ...) on any
 * validation failure — the caller (the fix-proposal worker) is responsible
 * for storing that as a FAILED proposal with the safe error message, never
 * as a silently-approved one.
 */
export async function proposeFixForIssue(
  issue: Pick<RepositoryIssue, 'title' | 'description' | 'filePath' | 'symbol' | 'lineStart' | 'lineEnd' | 'commitSha'>,
  repositoryId: string,
  currentCommitSha: string,
  analysis: IssueAnalysisProviderResult,
  indexedFiles: InsertIndexFileInput[],
  indexedChunks: InsertCodeChunkInput[],
  deps: ProposeFixDeps,
  signal?: AbortSignal,
): Promise<ProposeFixResult> {
  if (issue.commitSha !== currentCommitSha) {
    throw new FixProposalError(
      'The repository has been re-indexed since this issue was filed (commit mismatch) — analyze the issue again before proposing a fix.',
      'PROPOSAL_INVALID',
    );
  }

  const directEvidence: EvidenceChunkInput[] = gatherDirectEvidence(issue, indexedChunks).map((c) => ({
    filePath: c.filePath, language: c.language, symbol: c.symbol, symbolType: c.symbolType, startLine: c.startLine, endLine: c.endLine, content: c.content,
  }));

  let searchEvidence: EvidenceChunkInput[] = [];
  if (deps.searchForEvidence) {
    try {
      const query = [issue.title, issue.description].filter(Boolean).join(' — ');
      const results = await deps.searchForEvidence(repositoryId, query, REPOSITORY_FIX_MAX_FILES * 2);
      searchEvidence = results.map((r) => ({ filePath: r.filePath, language: r.language, symbol: r.symbol, symbolType: r.symbolType, startLine: r.startLine, endLine: r.endLine, content: r.content }));
    } catch {
      // Best-effort only — see SearchForEvidence's doc comment.
    }
  }
  const evidence = boundEvidence(directEvidence, searchEvidence);

  let aiResult;
  try {
    aiResult = await deps.provider.proposeFix({ title: issue.title, description: issue.description, analysis, evidence }, signal);
  } catch (error) {
    if (error instanceof FixProposalProviderError) {
      throw new FixProposalError(error.message, error.category === 'PROPOSAL_FAILED' ? 'PROPOSAL_FAILED' : error.category);
    }
    throw new FixProposalError('Fix proposal failed unexpectedly.', 'PROPOSAL_FAILED');
  }

  const validation = validateFixProposal(aiResult.files, indexedFiles, indexedChunks);
  if (!validation.ok) {
    throw new FixProposalError(validation.error, 'PROPOSAL_INVALID');
  }

  const proposedDiff = validation.files.map((f) => f.diff).join('\n\n');
  return { summary: aiResult.summary, filesChanged: validation.files, proposedDiff, model: aiResult.model };
}
