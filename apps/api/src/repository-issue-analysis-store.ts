import type { RepositoryIssueAnalysis } from '@origami/contracts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompleteAnalysisInput, CreateAnalysisInput } from './db/repository-issue-analysis-repository.js';

const DATA_DIR = process.env.SCAN_DATA_DIR ?? path.join(process.cwd(), '.origami-data');
const DATA_FILE = path.join(DATA_DIR, 'repository-issue-analyses.json');

const ACTIVE_STATUSES = new Set<RepositoryIssueAnalysis['status']>(['QUEUED', 'RUNNING']);

function nowIso(): string {
  return new Date().toISOString();
}

/** Always-available store (in-memory + JSON file), independent of Postgres. */
export class RepositoryIssueAnalysisStore {
  private analyses = new Map<string, RepositoryIssueAnalysis>();

  constructor() {
    this.loadFromDisk();
  }

  create(input: CreateAnalysisInput): RepositoryIssueAnalysis {
    const now = nowIso();
    const analysis: RepositoryIssueAnalysis = {
      id: input.id,
      issueId: input.issueId,
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      status: 'QUEUED',
      createdAt: now,
      updatedAt: now,
    };
    this.analyses.set(analysis.id, analysis);
    this.persistToDisk();
    return analysis;
  }

  markRunning(analysisId: string): void {
    const existing = this.analyses.get(analysisId);
    if (existing) this.analyses.set(analysisId, { ...existing, status: 'RUNNING', updatedAt: nowIso() });
    this.persistToDisk();
  }

  complete(analysisId: string, data: CompleteAnalysisInput): void {
    const existing = this.analyses.get(analysisId);
    if (!existing) return;
    this.analyses.set(analysisId, { ...existing, ...data, updatedAt: nowIso() });
    this.persistToDisk();
  }

  getById(analysisId: string): RepositoryIssueAnalysis | undefined {
    return this.analyses.get(analysisId);
  }

  getLatestForIssue(issueId: string): RepositoryIssueAnalysis | undefined {
    let latest: RepositoryIssueAnalysis | undefined;
    for (const analysis of this.analyses.values()) {
      if (analysis.issueId !== issueId) continue;
      if (!latest || new Date(analysis.createdAt).getTime() > new Date(latest.createdAt).getTime()) latest = analysis;
    }
    return latest;
  }

  /** Duplicate-job protection for the legacy store — mirrors the real Postgres partial unique index (uq_repository_issue_analyses_active) since the JSON-file fallback has no database constraint to enforce this for it. */
  hasActiveAnalysis(issueId: string): boolean {
    for (const analysis of this.analyses.values()) {
      if (analysis.issueId === issueId && ACTIVE_STATUSES.has(analysis.status)) return true;
    }
    return false;
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) as { analyses?: RepositoryIssueAnalysis[] };
      for (const analysis of raw.analyses ?? []) this.analyses.set(analysis.id, analysis);
    } catch {
      // Start fresh if data file is corrupt
    }
  }

  private persistToDisk(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({ analyses: Array.from(this.analyses.values()) }));
    } catch {
      // Non-fatal — in-memory store still works
    }
  }
}
