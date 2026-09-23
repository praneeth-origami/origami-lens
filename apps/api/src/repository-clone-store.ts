import type { RepositoryCloneJob } from '@origami/contracts';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DATA_DIR = process.env.SCAN_DATA_DIR ?? path.join(process.cwd(), '.origami-data');
const DATA_FILE = path.join(DATA_DIR, 'repository-clone-jobs.json');

/** Always-available store (in-memory + JSON file), independent of Postgres — mirrors repository-store.ts so this feature works without `pnpm db:setup`, same as every other job type in this project. */
export class RepositoryCloneStore {
  private jobs = new Map<string, RepositoryCloneJob>();

  constructor() {
    this.loadFromDisk();
  }

  save(job: RepositoryCloneJob): RepositoryCloneJob {
    this.jobs.set(job.jobId, job);
    this.persistToDisk();
    return job;
  }

  getById(jobId: string): RepositoryCloneJob | undefined {
    return this.jobs.get(jobId);
  }

  getLatestForRepository(repositoryId: string): RepositoryCloneJob | undefined {
    let latest: RepositoryCloneJob | undefined;
    for (const job of this.jobs.values()) {
      if (job.repositoryId !== repositoryId) continue;
      if (!latest || new Date(job.createdAt).getTime() > new Date(latest.createdAt).getTime()) {
        latest = job;
      }
    }
    return latest;
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const items = JSON.parse(raw) as RepositoryCloneJob[];
      for (const job of items) {
        this.jobs.set(job.jobId, job);
      }
    } catch {
      // Start fresh if data file is corrupt
    }
  }

  private persistToDisk(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(Array.from(this.jobs.values()), null, 2));
    } catch {
      // Non-fatal — in-memory store still works
    }
  }
}
