import type { RepositoryFixProposal } from '@origami/contracts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompleteProposalInput, CreateProposalInput } from './db/repository-fix-proposal-repository.js';

const DATA_DIR = process.env.SCAN_DATA_DIR ?? path.join(process.cwd(), '.origami-data');
const DATA_FILE = path.join(DATA_DIR, 'repository-fix-proposals.json');

const ACTIVE_STATUSES = new Set<RepositoryFixProposal['status']>(['QUEUED', 'RUNNING', 'FIX_PROPOSED']);

function nowIso(): string {
  return new Date().toISOString();
}

/** Always-available store (in-memory + JSON file), independent of Postgres. */
export class RepositoryFixProposalStore {
  private proposals = new Map<string, RepositoryFixProposal>();

  constructor() {
    this.loadFromDisk();
  }

  create(input: CreateProposalInput): RepositoryFixProposal {
    const now = nowIso();
    const proposal: RepositoryFixProposal = {
      id: input.id,
      issueId: input.issueId,
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      status: 'QUEUED',
      filesChanged: [],
      proposedDiff: '',
      createdAt: now,
      updatedAt: now,
    };
    this.proposals.set(proposal.id, proposal);
    this.persistToDisk();
    return proposal;
  }

  markRunning(proposalId: string): void {
    const existing = this.proposals.get(proposalId);
    if (existing) this.proposals.set(proposalId, { ...existing, status: 'RUNNING', updatedAt: nowIso() });
    this.persistToDisk();
  }

  complete(proposalId: string, data: CompleteProposalInput): void {
    const existing = this.proposals.get(proposalId);
    if (!existing) return;
    this.proposals.set(proposalId, {
      ...existing,
      status: data.status,
      summary: data.summary ?? existing.summary,
      filesChanged: data.filesChanged ?? existing.filesChanged,
      proposedDiff: data.proposedDiff ?? existing.proposedDiff,
      model: data.model ?? existing.model,
      validationError: data.validationError ?? existing.validationError,
      updatedAt: nowIso(),
    });
    this.persistToDisk();
  }

  setDecision(proposalId: string, status: 'APPROVED' | 'REJECTED'): RepositoryFixProposal | undefined {
    const existing = this.proposals.get(proposalId);
    if (!existing) return undefined;
    const updated: RepositoryFixProposal = { ...existing, status, updatedAt: nowIso() };
    this.proposals.set(proposalId, updated);
    this.persistToDisk();
    return updated;
  }

  getById(proposalId: string): RepositoryFixProposal | undefined {
    return this.proposals.get(proposalId);
  }

  listForIssue(issueId: string): RepositoryFixProposal[] {
    return Array.from(this.proposals.values())
      .filter((p) => p.issueId === issueId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /** Duplicate-proposal protection for the legacy store — mirrors the real Postgres partial unique index (uq_repository_fix_proposals_active). */
  hasActiveProposal(issueId: string): boolean {
    for (const proposal of this.proposals.values()) {
      if (proposal.issueId === issueId && ACTIVE_STATUSES.has(proposal.status)) return true;
    }
    return false;
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) as { proposals?: RepositoryFixProposal[] };
      for (const proposal of raw.proposals ?? []) this.proposals.set(proposal.id, proposal);
    } catch {
      // Start fresh if data file is corrupt
    }
  }

  private persistToDisk(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({ proposals: Array.from(this.proposals.values()) }));
    } catch {
      // Non-fatal — in-memory store still works
    }
  }
}
