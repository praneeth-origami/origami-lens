import type { RepositoryIndexJob } from '@origami/contracts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InsertCodeChunkInput, InsertIndexFileInput } from './db/repository-index-repository.js';

const DATA_DIR = process.env.SCAN_DATA_DIR ?? path.join(process.cwd(), '.origami-data');
const DATA_FILE = path.join(DATA_DIR, 'repository-index.json');

interface PersistedShape {
  jobs: RepositoryIndexJob[];
  files: InsertIndexFileInput[];
  chunks: InsertCodeChunkInput[];
}

/** Always-available store (in-memory + JSON file), independent of Postgres — mirrors repository-clone-store.ts. Dev/test scale only: a real deployment is expected to run with Postgres, same as every other job type in this project. */
export class RepositoryIndexStore {
  private jobs = new Map<string, RepositoryIndexJob>();
  private files = new Map<string, InsertIndexFileInput>();
  private chunks: InsertCodeChunkInput[] = [];

  constructor() {
    this.loadFromDisk();
  }

  saveJob(job: RepositoryIndexJob): RepositoryIndexJob {
    this.jobs.set(job.jobId, job);
    this.persistToDisk();
    return job;
  }

  getJobById(jobId: string): RepositoryIndexJob | undefined {
    return this.jobs.get(jobId);
  }

  getLatestJobForRepository(repositoryId: string): RepositoryIndexJob | undefined {
    return this.latestMatching((job) => job.repositoryId === repositoryId);
  }

  getLatestJobForCommit(repositoryId: string, commitSha: string): RepositoryIndexJob | undefined {
    return this.latestMatching((job) => job.repositoryId === repositoryId && job.commitSha === commitSha);
  }

  private latestMatching(predicate: (job: RepositoryIndexJob) => boolean): RepositoryIndexJob | undefined {
    let latest: RepositoryIndexJob | undefined;
    for (const job of this.jobs.values()) {
      if (!predicate(job)) continue;
      if (!latest || new Date(job.createdAt).getTime() > new Date(latest.createdAt).getTime()) latest = job;
    }
    return latest;
  }

  insertFile(input: InsertIndexFileInput): void {
    this.files.set(input.id, input);
    this.persistToDisk();
  }

  insertChunksBatch(chunks: InsertCodeChunkInput[]): void {
    this.chunks.push(...chunks);
    this.persistToDisk();
  }

  getFileCounts(indexJobId: string): { indexed: number; skipped: number } {
    let indexed = 0;
    let skipped = 0;
    for (const file of this.files.values()) {
      if (file.indexJobId !== indexJobId) continue;
      if (file.status === 'INDEXED') indexed += 1;
      else skipped += 1;
    }
    return { indexed, skipped };
  }

  getChunkCount(indexJobId: string): number {
    return this.chunks.filter((c) => c.indexJobId === indexJobId).length;
  }

  /** Added for Phase 4 (BGE-M3 embeddings) — see the matching addition on RepositoryIndexRepository. */
  getChunksForJob(indexJobId: string): InsertCodeChunkInput[] {
    return this.chunks.filter((c) => c.indexJobId === indexJobId);
  }

  getLanguageDistribution(indexJobId: string): Record<string, number> {
    const distribution: Record<string, number> = {};
    for (const file of this.files.values()) {
      if (file.indexJobId !== indexJobId || file.status !== 'INDEXED') continue;
      distribution[file.language] = (distribution[file.language] ?? 0) + 1;
    }
    return distribution;
  }

  /** Phase 8 — see the matching addition on RepositoryIndexRepository. */
  getFilesForJob(indexJobId: string): InsertIndexFileInput[] {
    return Array.from(this.files.values()).filter((f) => f.indexJobId === indexJobId);
  }

  deletePartialIndex(indexJobId: string): void {
    for (const [id, file] of this.files) {
      if (file.indexJobId === indexJobId) this.files.delete(id);
    }
    this.chunks = this.chunks.filter((c) => c.indexJobId !== indexJobId);
    this.persistToDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) as PersistedShape;
      for (const job of raw.jobs ?? []) this.jobs.set(job.jobId, job);
      for (const file of raw.files ?? []) this.files.set(file.id, file);
      this.chunks = raw.chunks ?? [];
    } catch {
      // Start fresh if data file is corrupt
    }
  }

  private persistToDisk(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const shape: PersistedShape = { jobs: Array.from(this.jobs.values()), files: Array.from(this.files.values()), chunks: this.chunks };
      fs.writeFileSync(DATA_FILE, JSON.stringify(shape));
    } catch {
      // Non-fatal — in-memory store still works
    }
  }
}
