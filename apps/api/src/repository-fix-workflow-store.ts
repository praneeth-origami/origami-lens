import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CreateWorkflowInput, RepositoryFixWorkflowRecord, UpdateWorkflowProgressInput } from './db/repository-fix-workflow-repository.js';

const DATA_DIR = process.env.SCAN_DATA_DIR ?? path.join(process.cwd(), '.origami-data');
const DATA_FILE = path.join(DATA_DIR, 'repository-fix-workflows.json');

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Always-available store (in-memory + JSON file), independent of Postgres —
 * same shape as every other legacy store in this project. claimForApproval
 * is a synchronous check-then-set with no `await` between the read and the
 * write, which IS atomic within a single Node.js process (no other task can
 * interleave), but — unlike the real Postgres row-level UPDATE this mirrors
 * — offers no cross-process guarantee. That limitation is inherent to the
 * legacy fallback tier itself (documented here rather than silently
 * assumed), consistent with every other legacy store's caveat in this
 * project; production concurrency protection relies on Postgres being
 * enabled (see the Phase 12 report's concurrency section).
 */
export class RepositoryFixWorkflowStore {
  private workflows = new Map<string, RepositoryFixWorkflowRecord>();

  constructor() {
    this.loadFromDisk();
  }

  create(input: CreateWorkflowInput): RepositoryFixWorkflowRecord {
    const now = nowIso();
    const record: RepositoryFixWorkflowRecord = {
      id: input.id,
      repositoryId: input.repositoryId,
      findingId: input.findingId,
      ownerId: input.ownerId,
      commitSha: input.commitSha,
      proposalHash: input.proposalHash,
      changedFiles: input.changedFiles,
      diff: input.diff,
      lineGrounding: input.lineGrounding,
      syntaxStatus: input.syntaxStatus,
      workspaceDir: input.workspaceDir,
      status: 'REVIEWABLE',
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
    };
    this.workflows.set(record.id, record);
    this.persistToDisk();
    return record;
  }

  getById(id: string): RepositoryFixWorkflowRecord | undefined {
    return this.workflows.get(id);
  }

  claimForApproval(id: string): RepositoryFixWorkflowRecord | undefined {
    const existing = this.workflows.get(id);
    if (!existing || existing.status !== 'REVIEWABLE') return undefined;
    const claimed: RepositoryFixWorkflowRecord = { ...existing, status: 'APPROVED', updatedAt: nowIso() };
    this.workflows.set(id, claimed);
    this.persistToDisk();
    return claimed;
  }

  updateProgress(id: string, data: UpdateWorkflowProgressInput): RepositoryFixWorkflowRecord | undefined {
    const existing = this.workflows.get(id);
    if (!existing) return undefined;
    const updated: RepositoryFixWorkflowRecord = {
      ...existing,
      status: data.status,
      branchName: data.branchName ?? existing.branchName,
      newCommitSha: data.newCommitSha ?? existing.newCommitSha,
      provider: data.provider ?? existing.provider,
      prNumber: data.prNumber ?? existing.prNumber,
      prUrl: data.prUrl ?? existing.prUrl,
      errorCode: data.errorCode,
      errorMessage: data.errorMessage,
      updatedAt: nowIso(),
    };
    this.workflows.set(id, updated);
    this.persistToDisk();
    return updated;
  }

  listExpiredReviewable(nowIsoValue: string): RepositoryFixWorkflowRecord[] {
    return Array.from(this.workflows.values()).filter((w) => w.status === 'REVIEWABLE' && w.expiresAt < nowIsoValue);
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) as { workflows?: RepositoryFixWorkflowRecord[] };
      for (const workflow of raw.workflows ?? []) this.workflows.set(workflow.id, workflow);
    } catch {
      // Start fresh if data file is corrupt
    }
  }

  private persistToDisk(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({ workflows: Array.from(this.workflows.values()) }));
    } catch {
      // Non-fatal — in-memory store still works
    }
  }
}
