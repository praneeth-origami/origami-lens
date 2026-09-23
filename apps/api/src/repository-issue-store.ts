import type { RepositoryIssue } from '@origami/contracts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CreateIssueInput } from './db/repository-issue-repository.js';

const DATA_DIR = process.env.SCAN_DATA_DIR ?? path.join(process.cwd(), '.origami-data');
const DATA_FILE = path.join(DATA_DIR, 'repository-issues.json');

function nowIso(): string {
  return new Date().toISOString();
}

/** Always-available store (in-memory + JSON file), independent of Postgres — mirrors repository-index-store.ts. */
export class RepositoryIssueStore {
  private issues = new Map<string, RepositoryIssue>();

  constructor() {
    this.loadFromDisk();
  }

  create(input: CreateIssueInput): RepositoryIssue {
    const now = nowIso();
    const issue: RepositoryIssue = {
      id: input.id,
      repositoryId: input.repositoryId,
      ownerId: input.ownerId,
      commitSha: input.commitSha,
      title: input.title,
      description: input.description,
      severity: input.severity,
      status: 'OPEN',
      source: input.source,
      filePath: input.filePath,
      symbol: input.symbol,
      lineStart: input.lineStart,
      lineEnd: input.lineEnd,
      createdAt: now,
      updatedAt: now,
    };
    this.issues.set(issue.id, issue);
    this.persistToDisk();
    return issue;
  }

  getById(issueId: string): RepositoryIssue | undefined {
    return this.issues.get(issueId);
  }

  listForRepository(repositoryId: string): RepositoryIssue[] {
    return Array.from(this.issues.values())
      .filter((i) => i.repositoryId === repositoryId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  updateStatus(issueId: string, status: RepositoryIssue['status']): RepositoryIssue | undefined {
    const existing = this.issues.get(issueId);
    if (!existing) return undefined;
    const updated: RepositoryIssue = { ...existing, status, updatedAt: nowIso() };
    this.issues.set(issueId, updated);
    this.persistToDisk();
    return updated;
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) as { issues?: RepositoryIssue[] };
      for (const issue of raw.issues ?? []) this.issues.set(issue.id, issue);
    } catch {
      // Start fresh if data file is corrupt
    }
  }

  private persistToDisk(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({ issues: Array.from(this.issues.values()) }));
    } catch {
      // Non-fatal — in-memory store still works
    }
  }
}
