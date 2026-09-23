import type { ComponentEvidence, ComponentGenerationJob, ComponentJobListItem } from '@origami/contracts';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DATA_DIR = process.env.SCAN_DATA_DIR ?? path.join(process.cwd(), '.origami-data');
const DATA_FILE = path.join(DATA_DIR, 'component-jobs.json');

/**
 * Always-available job store (in-memory + JSON file), independent of Postgres.
 * Mirrors ScanStore so Screenshot -> Code works out of the box the same way
 * CURRENT_PAGE scans do, without requiring `pnpm db:setup`.
 */
export class ComponentJobStore {
  private jobs = new Map<string, ComponentGenerationJob>();
  // Evidence (screenshot + DOM context) is kept in-memory only, not written to
  // disk, to avoid an ever-growing JSON file full of screenshots. Retry is
  // therefore only available for the lifetime of the API process when running
  // without Postgres — the same durability characteristic as the rest of this
  // fallback store.
  private evidenceByJobId = new Map<string, ComponentEvidence>();

  constructor() {
    this.loadFromDisk();
  }

  saveEvidence(jobId: string, evidence: ComponentEvidence): void {
    this.evidenceByJobId.set(jobId, evidence);
  }

  getEvidence(jobId: string): ComponentEvidence | undefined {
    return this.evidenceByJobId.get(jobId);
  }

  saveJob(job: ComponentGenerationJob): ComponentGenerationJob {
    this.jobs.set(job.jobId, job);
    this.persistToDisk();
    return job;
  }

  getJob(jobId: string): ComponentGenerationJob | undefined {
    return this.jobs.get(jobId);
  }

  /** The authorization-aware lookup for the no-Postgres fallback path: undefined for "doesn't exist" and "exists but isn't yours" identically. */
  getJobForOrganizations(jobId: string, organizationIds: string[]): ComponentGenerationJob | undefined {
    const job = this.jobs.get(jobId);
    return job && job.organizationId && organizationIds.includes(job.organizationId) ? job : undefined;
  }

  listJobs(): ComponentJobListItem[] {
    return Array.from(this.jobs.values())
      .map((j) => ({
        jobId: j.jobId,
        sourceUrl: j.sourceUrl,
        componentName: j.result?.componentName,
        target: j.target,
        status: j.status,
        createdAt: j.createdAt,
      }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /** Scoped to organizationIds so a caller can only ever delete their own job — mirrors UnifiedRepositoryStore's deleteForOrganizations. Returns false for "doesn't exist" and "exists but isn't yours" identically. */
  deleteForOrganizations(jobId: string, organizationIds: string[]): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !job.organizationId || !organizationIds.includes(job.organizationId)) return false;
    this.jobs.delete(jobId);
    this.evidenceByJobId.delete(jobId);
    this.persistToDisk();
    return true;
  }

  /** The only listing a real, authenticated caller ever gets for the no-Postgres fallback path: always scoped to every organization they belong to (unlike listJobs() above, which ignores ownership entirely). */
  listJobsForOrganizations(organizationIds: string[]): ComponentJobListItem[] {
    return Array.from(this.jobs.values())
      .filter((j) => j.organizationId && organizationIds.includes(j.organizationId))
      .map((j) => ({
        jobId: j.jobId,
        sourceUrl: j.sourceUrl,
        componentName: j.result?.componentName,
        target: j.target,
        status: j.status,
        createdAt: j.createdAt,
      }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const items = JSON.parse(raw) as ComponentGenerationJob[];
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
