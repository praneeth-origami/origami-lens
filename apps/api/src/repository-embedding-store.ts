import type { RepositoryEmbeddingJob } from '@origami/contracts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InsertEmbeddingInput } from './db/repository-embedding-repository.js';

const DATA_DIR = process.env.SCAN_DATA_DIR ?? path.join(process.cwd(), '.origami-data');
const DATA_FILE = path.join(DATA_DIR, 'repository-embeddings.json');

interface PersistedShape {
  jobs: RepositoryEmbeddingJob[];
  embeddings: InsertEmbeddingInput[];
}

/** Always-available store (in-memory + JSON file), independent of Postgres — mirrors repository-index-store.ts. Dev/test scale only, matching every other job type's fallback in this project. */
export class RepositoryEmbeddingStore {
  private jobs = new Map<string, RepositoryEmbeddingJob>();
  /** Keyed by `${repositoryId}:${commitSha}:${model}:${contentHash}` — mirrors the real unique constraint from 008_repository_embeddings.sql. */
  private embeddings = new Map<string, InsertEmbeddingInput>();

  constructor() {
    this.loadFromDisk();
  }

  private key(repositoryId: string, commitSha: string, model: string, contentHash: string): string {
    return `${repositoryId}:${commitSha}:${model}:${contentHash}`;
  }

  saveJob(job: RepositoryEmbeddingJob): RepositoryEmbeddingJob {
    this.jobs.set(job.jobId, job);
    this.persistToDisk();
    return job;
  }

  getJobById(jobId: string): RepositoryEmbeddingJob | undefined {
    return this.jobs.get(jobId);
  }

  getLatestJobForRepository(repositoryId: string): RepositoryEmbeddingJob | undefined {
    return this.latestMatching((job) => job.repositoryId === repositoryId);
  }

  getLatestJobForCommit(repositoryId: string, commitSha: string): RepositoryEmbeddingJob | undefined {
    return this.latestMatching((job) => job.repositoryId === repositoryId && job.commitSha === commitSha);
  }

  private latestMatching(predicate: (job: RepositoryEmbeddingJob) => boolean): RepositoryEmbeddingJob | undefined {
    let latest: RepositoryEmbeddingJob | undefined;
    for (const job of this.jobs.values()) {
      if (!predicate(job)) continue;
      if (!latest || new Date(job.createdAt).getTime() > new Date(latest.createdAt).getTime()) latest = job;
    }
    return latest;
  }

  findExistingByContentHashes(repositoryId: string, commitSha: string, model: string, contentHashes: string[]): Set<string> {
    const found = new Set<string>();
    for (const hash of contentHashes) {
      if (this.embeddings.has(this.key(repositoryId, commitSha, model, hash))) found.add(hash);
    }
    return found;
  }

  /** Silently skips a duplicate (repository, commit, contentHash, model) — mirrors the real unique-constraint + ON CONFLICT DO NOTHING behavior. */
  insertEmbeddingsBatch(embeddings: InsertEmbeddingInput[]): void {
    for (const embedding of embeddings) {
      const k = this.key(embedding.repositoryId, embedding.commitSha, embedding.model, embedding.contentHash);
      if (!this.embeddings.has(k)) this.embeddings.set(k, embedding);
    }
    this.persistToDisk();
  }

  /** Added for Phase 5 (search) — the no-Postgres fallback path for vector retrieval computes cosine distance over these directly (see repository-search-service.ts), since there is no in-memory pgvector equivalent. Purely additive; every method above is unchanged. */
  getEmbeddingsForCommit(repositoryId: string, commitSha: string, model: string): InsertEmbeddingInput[] {
    return Array.from(this.embeddings.values()).filter(
      (e) => e.repositoryId === repositoryId && e.commitSha === commitSha && e.model === model,
    );
  }

  countEmbeddings(repositoryId: string, commitSha: string, model: string): number {
    let count = 0;
    for (const e of this.embeddings.values()) {
      if (e.repositoryId === repositoryId && e.commitSha === commitSha && e.model === model) count += 1;
    }
    return count;
  }

  deleteEmbeddingsForJob(embeddingJobId: string): void {
    for (const [k, e] of this.embeddings) {
      if (e.embeddingJobId === embeddingJobId) this.embeddings.delete(k);
    }
    this.persistToDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) as PersistedShape;
      for (const job of raw.jobs ?? []) this.jobs.set(job.jobId, job);
      for (const embedding of raw.embeddings ?? []) {
        this.embeddings.set(this.key(embedding.repositoryId, embedding.commitSha, embedding.model, embedding.contentHash), embedding);
      }
    } catch {
      // Start fresh if data file is corrupt
    }
  }

  private persistToDisk(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const shape: PersistedShape = { jobs: Array.from(this.jobs.values()), embeddings: Array.from(this.embeddings.values()) };
      fs.writeFileSync(DATA_FILE, JSON.stringify(shape));
    } catch {
      // Non-fatal — in-memory store still works
    }
  }
}
