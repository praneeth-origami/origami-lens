import type {
  AggregatedIssue,
  CodeTarget,
  ComponentGenerationJob,
  ComponentJobListItem,
  Issue,
  IssueFilters,
  IssueStatus,
  PageScanRecord,
  ScanListItem,
  ScanResponse,
  ScanStatusResponse,
  Severity,
} from '@origami/contracts';
import { CODE_TARGET_META } from '@origami/contracts';

const API_BASE = import.meta.env.VITE_API_URL ?? '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export function fetchScans() {
  return request<{ scans: ScanListItem[] }>('/scans');
}

export interface DependencyHealth {
  api: { status: 'ok' | 'down'; service: string; error?: string };
  browserWorker: { status: 'ok' | 'down'; service: string; error?: string };
  aiRouter: { status: 'ok' | 'down'; service: string; error?: string };
  readyForScan: boolean;
}

export function fetchDependencyHealth() {
  return request<DependencyHealth>('/health/dependencies');
}

export function fetchScan(scanId: string) {
  return request<ScanResponse & { issuesByCategory: Record<string, number> }>(`/scans/${scanId}`);
}

export function fetchScanStatus(scanId: string) {
  return request<ScanStatusResponse>(`/scans/${scanId}/status`);
}

export function fetchScanPages(scanId: string) {
  return request<{ scanId: string; pages: PageScanRecord[] }>(`/scans/${scanId}/pages`);
}

export function fetchPageScanDetail(scanId: string, pageScanId: string) {
  return request<{ scanId: string; page: PageScanRecord; issues: Issue[] }>(
    `/scans/${scanId}/pages/${pageScanId}`,
  );
}

export function fetchScanIssues(scanId: string, filters: IssueFilters) {
  const params = new URLSearchParams();
  if (filters.severity && filters.severity !== 'all') params.set('severity', filters.severity);
  if (filters.category && filters.category !== 'all') params.set('category', filters.category);
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.search) params.set('search', filters.search);
  if (filters.sort) params.set('sort', filters.sort);
  const qs = params.toString();
  return request<{ issues: Issue[]; total: number; url: string; scanId: string }>(
    `/scans/${scanId}/issues${qs ? `?${qs}` : ''}`,
  );
}

export function fetchIssue(issueId: string) {
  return request<{
    issue: Issue | AggregatedIssue;
    scan: {
      scanId: string;
      url: string;
      scannedAt: string;
      healthScore: ScanResponse['healthScore'];
      scanType?: ScanResponse['scanType'];
    };
  }>(`/issues/${issueId}`);
}

export function updateIssueStatus(issueId: string, status: IssueStatus) {
  return request<{ issue: Issue }>(`/issues/${issueId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function askAi(question: string, issue: Issue, url: string) {
  return request<{ answer: string; aiAvailable: boolean }>('/ai/ask', {
    method: 'POST',
    body: JSON.stringify({ question, issue, url }),
  });
}

export function suggestFix(issue: Issue, url: string) {
  return request<{ fix: Record<string, unknown>; aiAvailable: boolean }>('/ai/suggest-fix', {
    method: 'POST',
    body: JSON.stringify({ issue, url }),
  });
}

export function fetchComponentJobs() {
  return request<{ jobs: ComponentJobListItem[] }>('/components');
}

export function fetchComponentJob(jobId: string) {
  return request<ComponentGenerationJob>(`/components/${jobId}`);
}

export function retryComponentJob(jobId: string, target?: CodeTarget) {
  return request<{ jobId: string; status: string }>(`/components/${jobId}/retry`, {
    method: 'POST',
    body: JSON.stringify({ target }),
  });
}

export function cancelComponentJob(jobId: string) {
  return request<{ jobId: string; status: string }>(`/components/${jobId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export { CODE_TARGET_META };
export type { CodeTarget };

export type SeverityTab = 'all' | Severity;

export const SEVERITY_LABEL: Record<Severity, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

export const CATEGORY_LABEL: Record<string, string> = {
  functional: 'Functional',
  performance: 'Performance',
  visualMobile: 'Visual / Mobile',
  accessibility: 'Accessibility',
  bestPractices: 'Best Practices',
  seo: 'SEO',
  securityHygiene: 'Security Hygiene',
};

export const STATUS_LABEL: Record<IssueStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  ignored: 'Ignored',
};
