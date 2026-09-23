import type { Repository } from '@origami/contracts';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DATA_DIR = process.env.SCAN_DATA_DIR ?? path.join(process.cwd(), '.origami-data');
const DATA_FILE = path.join(DATA_DIR, 'repositories.json');

/**
 * Always-available store (in-memory + JSON file), independent of Postgres —
 * mirrors ComponentJobStore/ScanStore so the Repository feature works out of
 * the box the same way Screenshot -> Code and scans already do, without
 * requiring `pnpm db:setup`.
 */
export class RepositoryStore {
  private repositories = new Map<string, Repository>();

  constructor() {
    this.loadFromDisk();
  }

  save(repository: Repository): Repository {
    this.repositories.set(repository.id, repository);
    this.persistToDisk();
    return repository;
  }

  getById(id: string): Repository | undefined {
    return this.repositories.get(id);
  }

  /** Phase 2 — the authorization-aware lookup for the no-Postgres fallback path: undefined for "doesn't exist" and "exists but isn't yours" identically. */
  getByIdForOrganizations(id: string, organizationIds: string[]): Repository | undefined {
    const repository = this.repositories.get(id);
    return repository && repository.organizationId && organizationIds.includes(repository.organizationId) ? repository : undefined;
  }

  /** Returns false for "doesn't exist" and "exists but isn't yours" identically, same generic-404 convention as every other ForOrganizations method here. */
  deleteForOrganizations(id: string, organizationIds: string[]): boolean {
    if (!this.getByIdForOrganizations(id, organizationIds)) return false;
    this.repositories.delete(id);
    this.persistToDisk();
    return true;
  }

  /** Unlike ComponentJobStore.listJobs() (which ignores ownerId entirely in its no-Postgres fallback), this filters correctly so owner isolation holds even without Postgres configured. */
  list(ownerId?: string): Repository[] {
    return Array.from(this.repositories.values())
      .filter((r) => !ownerId || r.ownerId === ownerId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /** Phase 2 — the only listing a real, authenticated caller ever gets: always scoped to every organization they belong to. */
  listForOrganizations(organizationIds: string[]): Repository[] {
    return Array.from(this.repositories.values())
      .filter((r) => r.organizationId && organizationIds.includes(r.organizationId))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /** True if an existing repository already matches this owner+normalizedUrl+branch combination — mirrors the Postgres unique constraint for the no-Postgres fallback path. Phase 2: "owner" now means the organizationId, not the legacy client-supplied ownerId or the audit-only userId. */
  findDuplicate(organizationId: string | undefined, repoUrl: string, branch: string): Repository | undefined {
    return Array.from(this.repositories.values()).find(
      (r) => r.organizationId === organizationId && r.repoUrl === repoUrl && r.branch === branch,
    );
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const items = JSON.parse(raw) as Repository[];
      for (const repository of items) {
        this.repositories.set(repository.id, repository);
      }
    } catch {
      // Start fresh if data file is corrupt
    }
  }

  private persistToDisk(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(Array.from(this.repositories.values()), null, 2));
    } catch {
      // Non-fatal — in-memory store still works
    }
  }
}
