import { randomUUID } from 'node:crypto';
import type {
  BugReport,
  BugReportDomEvidence,
  BugReportErrorCode,
  ConsoleEntry,
  CreateBugReportRequest,
  CreateBugReportResponse,
  NetworkEntry,
  Severity,
  IssueCategory,
} from '@origami/contracts';
import { CATEGORY_LABEL } from '@origami/contracts';
import { scrubString } from '@origami/privacy';
import type { CreateBugReportRow } from './db/bug-report-repository.js';
import { GitHubIssueError, mapProviderError } from './repository-github-issue-service.js';
import { RepositoryProviderError } from './repository-provider-client.js';
import { canAccessRepository, parseRepositoryUrl } from './repository-service.js';

export class BugReportError extends Error {
  constructor(message: string, public readonly code: BugReportErrorCode) {
    super(message);
    this.name = 'BugReportError';
  }
}

const MAX_CONSOLE_ERRORS = 20;
const MAX_NETWORK_ERRORS = 20;
const MAX_REPRODUCTION_STEPS = 20;
const MAX_TEXT_LENGTH = 5_000;
const MAX_SCREENSHOT_BYTES = 6_000_000; // base64 length, generous — matches a full-viewport JPEG

const VALID_SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const VALID_CATEGORIES: IssueCategory[] = ['functional', 'performance', 'visualMobile', 'accessibility', 'bestPractices', 'seo', 'securityHygiene'];

function bounded(text: string, max = MAX_TEXT_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function scrubConsoleErrors(entries: ConsoleEntry[]): ConsoleEntry[] {
  return entries.slice(0, MAX_CONSOLE_ERRORS).map((e) => ({
    ...e,
    message: bounded(scrubString(e.message)),
    stack: e.stack ? bounded(scrubString(e.stack)) : e.stack,
  }));
}

function scrubNetworkErrors(entries: NetworkEntry[]): NetworkEntry[] {
  return entries.slice(0, MAX_NETWORK_ERRORS).map((e) => ({
    ...e,
    url: bounded(scrubString(e.url), 500),
  }));
}

function scrubDomEvidence(evidence: BugReportDomEvidence | undefined): BugReportDomEvidence | undefined {
  if (!evidence) return undefined;
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(evidence.attributes)) attributes[key] = scrubString(value);
  const computedStyles: Record<string, string> = {};
  for (const [key, value] of Object.entries(evidence.computedStyles)) computedStyles[key] = scrubString(value);
  return {
    ...evidence,
    text: evidence.text ? scrubString(evidence.text) : evidence.text,
    html: bounded(scrubString(evidence.html)),
    attributes,
    computedStyles,
    accessibleName: evidence.accessibleName ? scrubString(evidence.accessibleName) : evidence.accessibleName,
  };
}

function validate(input: CreateBugReportRequest): void {
  if (!input.title?.trim()) throw new BugReportError('A title is required.', 'BUG_REPORT_INVALID');
  if (!input.url?.trim()) throw new BugReportError('url is required.', 'BUG_REPORT_INVALID');
  if (!input.description?.trim()) throw new BugReportError('A description is required.', 'BUG_REPORT_INVALID');
  if (!VALID_SEVERITIES.includes(input.severity)) throw new BugReportError('Invalid severity.', 'BUG_REPORT_INVALID');
  if (!VALID_CATEGORIES.includes(input.category)) throw new BugReportError('Invalid category.', 'BUG_REPORT_INVALID');
  if (input.screenshotBase64 && input.screenshotBase64.length > MAX_SCREENSHOT_BYTES) {
    throw new BugReportError('Screenshot is too large.', 'BUG_REPORT_INVALID');
  }
}

export interface BugReportRepo {
  create(input: CreateBugReportRow): Promise<BugReport>;
  getByIdForOrganizationsAsync(id: string, organizationIds: string[]): Promise<BugReport | undefined>;
  linkGitHubIssue(id: string, link: { repositoryId: string; issueNumber: number; issueUrl: string }): Promise<void>;
}

export interface BugReportArtifactStore {
  saveImage(id: string, key: string, base64: string): void;
}

export interface BugReportStores {
  repo: BugReportRepo;
  artifactStore: BugReportArtifactStore;
}

/**
 * Create Bug Report — captures a self-contained incident record from the
 * REAL page the user was viewing (url/browser/OS/viewport/screenshot come
 * from the request body, which the extension populates from the live tab —
 * see selection-overlay.ts's captureBugReportEvidence). Every free-text
 * field is scrubbed here via the SAME scrubString the rest of the codebase
 * already uses — defense in depth on top of whatever the extension itself
 * already did not collect (passwords/tokens are never even read client-side
 * — see detectBlockingSensitiveContent's reuse there).
 *
 * When linkedIssueId is set, the CALLER (the route handler, which already
 * has organization-scoped access to the store) is responsible for looking
 * up that issue and passing its real, already-generated suggestedFix/
 * category/severity via `linkedIssue` — never trusting a client-supplied
 * suggestedFix (CreateBugReportRequest has no such field at all), and never
 * regenerating one here.
 */
export async function createBugReport(
  input: CreateBugReportRequest,
  organizationId: string | undefined,
  userId: string,
  stores: BugReportStores,
  webAppBaseUrl: string,
  linkedIssue?: { suggestedFix?: string; category: IssueCategory; severity: Severity },
): Promise<CreateBugReportResponse> {
  validate(input);

  const suggestedFix = linkedIssue?.suggestedFix;
  const category = linkedIssue?.category ?? input.category;
  const severity = linkedIssue?.severity ?? input.severity;

  const id = randomUUID();
  const report = await stores.repo.create({
    id,
    organizationId,
    createdByUserId: userId,
    title: bounded(scrubString(input.title.trim()), 300),
    url: bounded(scrubString(input.url.trim()), 2000),
    pageTitle: input.pageTitle ? bounded(scrubString(input.pageTitle), 300) : undefined,
    browser: bounded(scrubString(input.browser), 100),
    operatingSystem: bounded(scrubString(input.operatingSystem), 100),
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
    devicePixelRatio: input.devicePixelRatio,
    hasScreenshot: Boolean(input.screenshotBase64),
    consoleErrors: scrubConsoleErrors(input.consoleErrors ?? []),
    networkErrors: scrubNetworkErrors(input.networkErrors ?? []),
    domEvidence: scrubDomEvidence(input.domEvidence),
    description: bounded(scrubString(input.description.trim())),
    severity,
    category,
    reproductionSteps: (input.reproductionSteps ?? []).slice(0, MAX_REPRODUCTION_STEPS).map((s) => bounded(scrubString(s), 500)),
    expectedBehavior: input.expectedBehavior ? bounded(scrubString(input.expectedBehavior)) : undefined,
    actualBehavior: input.actualBehavior ? bounded(scrubString(input.actualBehavior)) : undefined,
    suggestedFix: suggestedFix ? bounded(scrubString(suggestedFix)) : undefined,
    linkedIssueId: input.linkedIssueId,
    linkedScanId: input.linkedScanId,
  });

  if (input.screenshotBase64) {
    stores.artifactStore.saveImage(report.id, 'screenshot.jpg', input.screenshotBase64);
  }

  return { id: report.id, url: `${webAppBaseUrl}/bug-reports/${report.id}` };
}

export async function getBugReport(id: string, organizationIds: string[], repo: BugReportRepo): Promise<BugReport> {
  const report = await repo.getByIdForOrganizationsAsync(id, organizationIds);
  if (!report) throw new BugReportError('Bug report not found.', 'BUG_REPORT_NOT_FOUND');
  return report;
}

/** A concise, developer-friendly GitHub issue body built from the bug report's OWN fields — never a raw dump of every captured console/network entry (bounded to the first few most relevant). */
function buildGitHubIssueBodyFromBugReport(report: BugReport): string {
  const lines: string[] = [];
  lines.push('## Problem', '', report.description, '');
  lines.push('## Page', '', report.url, '');
  lines.push('## Environment', '', `Browser: ${report.browser}`, `OS: ${report.operatingSystem}`, `Viewport: ${report.viewportWidth} × ${report.viewportHeight} (DPR ${report.devicePixelRatio})`, '');
  if (report.reproductionSteps.length > 0) {
    lines.push('## Reproduction', '');
    report.reproductionSteps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    lines.push('');
  }
  if (report.expectedBehavior) lines.push('## Expected Behavior', '', report.expectedBehavior, '');
  if (report.actualBehavior) lines.push('## Actual Behavior', '', report.actualBehavior, '');
  if (report.domEvidence) {
    lines.push('## Element', '', `\`${report.domEvidence.selector}\``, '');
  }
  if (report.consoleErrors.length > 0) {
    lines.push('## Console Errors', '', '```');
    for (const e of report.consoleErrors.slice(0, 5)) lines.push(`[${e.type}] ${e.message}`);
    lines.push('```', '');
  }
  if (report.networkErrors.length > 0) {
    lines.push('## Network Errors', '', '```');
    for (const e of report.networkErrors.slice(0, 5)) lines.push(`${e.method} ${e.url} → ${e.status}`);
    lines.push('```', '');
  }
  if (report.suggestedFix) lines.push('## Suggested Fix', '', report.suggestedFix, '');
  lines.push('## Origami Lens', '', `Bug Report: ${report.id}`);
  if (report.linkedIssueId) lines.push(`Linked Issue: ${report.linkedIssueId}`);
  lines.push('', '_Filed automatically from an Origami Lens bug report._');
  return lines.join('\n');
}

function buildGitHubIssueLabelsFromBugReport(report: BugReport): string[] {
  const categoryLabel = CATEGORY_LABEL[report.category].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return [categoryLabel, report.severity.toLowerCase(), 'bug-report'];
}

export interface CreateBugReportGitHubIssueDeps {
  provider: import('./repository-provider-client.js').RepositoryProviderClient;
  repo: BugReportRepo;
}

/**
 * Create GitHub Issue from a Bug Report — DISTINCT from
 * createGitHubIssueForFinding (a scan finding): same underlying credential
 * resolution/GitHub API call/error mapping (never a second GitHub
 * integration), different source data (a BugReport's own fields, not an
 * Issue's).
 *
 * Idempotent (bugfix): a bug report's GitHub issue link is permanent once
 * set (migration 039) — a report that already has one returns it directly
 * without calling GitHub again, so reloading the page (whose React state
 * resets) or clicking Create a second time can never create a second,
 * duplicate issue for the same report.
 */
export async function createGitHubIssueFromBugReport(
  userId: string,
  repository: { id: string; organizationId?: string; repoUrl: string; provider?: string } | undefined,
  callerOrganizationId: string | undefined,
  report: BugReport,
  deps: CreateBugReportGitHubIssueDeps,
  signal?: AbortSignal,
): Promise<{ issueNumber: number; issueUrl: string }> {
  if (report.githubIssueUrl && report.githubIssueNumber !== undefined) {
    return { issueNumber: report.githubIssueNumber, issueUrl: report.githubIssueUrl };
  }

  if (!repository) throw new GitHubIssueError('Repository not found.', 'REPOSITORY_NOT_FOUND');
  if (!canAccessRepository(repository.organizationId, callerOrganizationId)) {
    throw new GitHubIssueError('Repository not found.', 'REPOSITORY_ACCESS_DENIED');
  }
  if (!deps.provider.createIssue) {
    throw new GitHubIssueError(`Creating a GitHub issue is not yet supported for provider "${repository.provider ?? 'unknown'}".`, 'PROVIDER_UNSUPPORTED');
  }
  const parsed = parseRepositoryUrl(repository.repoUrl);
  if (!parsed.ok) throw new GitHubIssueError('Could not resolve the repository owner/name from its URL.', 'REPOSITORY_NOT_FOUND');

  try {
    const result = await deps.provider.createIssue(
      userId,
      {
        owner: parsed.value.owner,
        repo: parsed.value.name,
        title: report.title,
        body: buildGitHubIssueBodyFromBugReport(report),
        labels: buildGitHubIssueLabelsFromBugReport(report),
      },
      signal,
    );
    await deps.repo.linkGitHubIssue(report.id, { repositoryId: repository.id, issueNumber: result.number, issueUrl: result.url });
    return { issueNumber: result.number, issueUrl: result.url };
  } catch (error) {
    if (error instanceof RepositoryProviderError) throw mapProviderError(error);
    throw new GitHubIssueError(error instanceof Error ? error.message : 'Failed to create the GitHub issue.', 'GITHUB_REQUEST_FAILED');
  }
}
