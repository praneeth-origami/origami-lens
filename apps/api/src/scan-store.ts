import type { Issue, IssueFilters, IssueStatus, ScanListItem, ScanResponse, ScanSummary, Severity } from '@origami/contracts';
import { normalizeLegacySeverity, SEVERITY_ORDER } from '@origami/contracts';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DATA_DIR = process.env.SCAN_DATA_DIR ?? path.join(process.cwd(), '.origami-data');
const DATA_FILE = path.join(DATA_DIR, 'scans.json');

type LegacyScanSummary = ScanSummary & { important?: number; minor?: number };

function migrateScan(scan: ScanResponse): ScanResponse {
  const legacy = scan.summary as LegacyScanSummary;
  const issues = scan.issues.map((issue) => ({
    ...issue,
    severity: normalizeLegacySeverity(issue.severity),
  }));

  const summary: ScanSummary =
    typeof legacy.high === 'number'
      ? { ...legacy, totalIssues: issues.length }
      : {
          totalIssues: issues.length,
          critical: legacy.critical ?? 0,
          high: legacy.important ?? 0,
          medium: 0,
          low: legacy.minor ?? 0,
          aiAvailable: legacy.aiAvailable ?? false,
        };

  if (typeof legacy.high !== 'number') {
    const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const issue of issues) {
      counts[issue.severity] += 1;
    }
    summary.critical = counts.CRITICAL;
    summary.high = counts.HIGH;
    summary.medium = counts.MEDIUM;
    summary.low = counts.LOW;
    summary.totalIssues = issues.length;
  }

  return { ...scan, issues, summary };
}

export class ScanStore {
  private scans = new Map<string, ScanResponse>();

  constructor() {
    this.loadFromDisk();
  }

  saveScan(scan: ScanResponse): ScanResponse {
    this.scans.set(scan.scanId, scan);
    this.persistToDisk();
    return scan;
  }

  getScan(scanId: string): ScanResponse | undefined {
    const scan = this.scans.get(scanId);
    return scan ? migrateScan(scan) : undefined;
  }

  /** Returns false for "doesn't exist" and "exists but isn't yours" identically, same generic-404 convention as every other ForOrganizations method here. */
  deleteScanForOrganizations(scanId: string, organizationIds: string[]): boolean {
    if (!this.getScanForOrganizations(scanId, organizationIds)) return false;
    this.scans.delete(scanId);
    this.persistToDisk();
    return true;
  }

  /** The authorization-aware lookup for the no-Postgres fallback path: undefined for "doesn't exist" and "exists but isn't yours" identically. */
  getScanForOrganizations(scanId: string, organizationIds: string[]): ScanResponse | undefined {
    const scan = this.getScan(scanId);
    if (!scan || !scan.organizationId || !organizationIds.includes(scan.organizationId)) return undefined;
    return scan;
  }

  listScans(): ScanListItem[] {
    return Array.from(this.scans.values())
      .map((s) => ({
        scanId: s.scanId,
        url: s.url,
        overallScore: s.healthScore.overallScore,
        totalIssues: s.summary.totalIssues,
        critical: s.summary.critical,
        high: s.summary.high,
        medium: s.summary.medium,
        low: s.summary.low,
        scannedAt: s.scannedAt,
      }))
      .sort((a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime());
  }

  /** The only listing a real, authenticated caller ever gets: always scoped to every organization they belong to. */
  listScansForOrganizations(organizationIds: string[]): ScanListItem[] {
    return Array.from(this.scans.values())
      .filter((s) => s.organizationId && organizationIds.includes(s.organizationId))
      .map((s) => ({
        scanId: s.scanId,
        url: s.url,
        overallScore: s.healthScore.overallScore,
        totalIssues: s.summary.totalIssues,
        critical: s.summary.critical,
        high: s.summary.high,
        medium: s.summary.medium,
        low: s.summary.low,
        scannedAt: s.scannedAt,
      }))
      .sort((a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime());
  }

  getIssue(issueId: string): { issue: Issue; scan: ScanResponse } | undefined {
    for (const scan of this.scans.values()) {
      const issue = scan.issues.find((i) => i.id === issueId);
      if (issue) return { issue, scan };
    }
    return undefined;
  }

  /** The authorization-aware lookup for the no-Postgres fallback path: an issue belongs to whichever scan found it. */
  getIssueForOrganizations(issueId: string, organizationIds: string[]): { issue: Issue; scan: ScanResponse } | undefined {
    const found = this.getIssue(issueId);
    if (!found || !found.scan.organizationId || !organizationIds.includes(found.scan.organizationId)) return undefined;
    return found;
  }

  updateIssueStatus(issueId: string, status: IssueStatus): Issue | undefined {
    for (const scan of this.scans.values()) {
      const idx = scan.issues.findIndex((i) => i.id === issueId);
      if (idx >= 0) {
        scan.issues[idx] = { ...scan.issues[idx], status };
        this.scans.set(scan.scanId, scan);
        this.persistToDisk();
        return scan.issues[idx];
      }
    }
    return undefined;
  }

  /** The authorization-aware mutation for the no-Postgres fallback path — verifies the issue's scan belongs to one of the caller's organizations before writing. */
  updateIssueStatusForOrganizations(issueId: string, status: IssueStatus, organizationIds: string[]): Issue | undefined {
    if (!this.getIssueForOrganizations(issueId, organizationIds)) return undefined;
    return this.updateIssueStatus(issueId, status);
  }

  /** Persists which repository a finding's AI fix/PR should target (see repository-finding-resolution-service.ts) — same shape as updateIssueStatus, just a different field. */
  updateIssueRepository(issueId: string, repositoryId: string): Issue | undefined {
    for (const scan of this.scans.values()) {
      const idx = scan.issues.findIndex((i) => i.id === issueId);
      if (idx >= 0) {
        scan.issues[idx] = { ...scan.issues[idx], repositoryId };
        this.scans.set(scan.scanId, scan);
        this.persistToDisk();
        return scan.issues[idx];
      }
    }
    return undefined;
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const items = JSON.parse(raw) as ScanResponse[];
      for (const scan of items) {
        this.scans.set(scan.scanId, migrateScan(scan));
      }
    } catch {
      // Start fresh if data file is corrupt
    }
  }

  private persistToDisk(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(Array.from(this.scans.values()), null, 2));
    } catch {
      // Non-fatal — in-memory store still works
    }
  }
}

export function filterIssues(issues: Issue[], filters: IssueFilters): Issue[] {
  let result = [...issues];

  if (filters.severity && filters.severity !== 'all') {
    const target = filters.severity as Severity;
    result = result.filter((i) => normalizeLegacySeverity(i.severity) === target);
  }

  if (filters.category && filters.category !== 'all') {
    result = result.filter((i) => i.category === filters.category);
  }

  if (filters.status && filters.status !== 'all') {
    result = result.filter((i) => (i.status ?? 'open') === filters.status);
  }

  if (filters.search?.trim()) {
    const q = filters.search.trim().toLowerCase();
    result = result.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        i.problem.toLowerCase().includes(q) ||
        i.type.toLowerCase().includes(q) ||
        i.category.toLowerCase().includes(q),
    );
  }

  const sort = filters.sort ?? 'severity';
  result.sort((a, b) => {
    switch (sort) {
      case 'category':
        return a.category.localeCompare(b.category);
      case 'newest':
        return new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime();
      case 'oldest':
        return new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime();
      case 'severity':
      default:
        return (SEVERITY_ORDER[normalizeLegacySeverity(a.severity)] ?? 4) -
          (SEVERITY_ORDER[normalizeLegacySeverity(b.severity)] ?? 4);
    }
  });

  return result;
}

export function countIssuesByCategory(issues: Issue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    counts[issue.category] = (counts[issue.category] ?? 0) + 1;
  }
  return counts;
}
