import type { HealthScore, Issue, PageAskErrorCode, PageAskResponse, ScanStatus } from '@origami/contracts';
import { isReportReady } from './report-service.js';
import { buildPageQaContext } from './page-qa-context.js';
import { PageQaProviderError, type PageQaProvider } from './page-qa-provider.js';

export class PageAskError extends Error {
  constructor(message: string, public readonly code: PageAskErrorCode) {
    super(message);
    this.name = 'PageAskError';
  }
}

export interface PageAskDeps {
  qaProvider: PageQaProvider;
}

interface PageEvidenceRecord {
  url: string;
  status: ScanStatus;
  healthScore?: object;
  fullEvidence?: import('@origami/contracts').BrowserEvidence;
  issues: Issue[];
  issueCount: number;
}

export interface PageAskStores {
  getScanEvidenceForOrganizations(scanId: string, organizationIds: string[]): Promise<(PageEvidenceRecord & { scanId: string }) | undefined>;
  getPageScanEvidenceForOrganizations(scanId: string, pageScanId: string, organizationIds: string[]): Promise<(PageEvidenceRecord & { pageScanId: string }) | undefined>;
}

function logPageAskCompleted(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: 'page_ask_completed', ...fields }));
}

function validateQuestion(question: unknown): string {
  if (typeof question !== 'string' || !question.trim()) {
    throw new PageAskError('question is required', 'ASK_QUESTION_INVALID');
  }
  return question;
}

async function callProvider(contextText: string, question: string, deps: PageAskDeps, signal?: AbortSignal): Promise<{ answer: string; model: string }> {
  try {
    return await deps.qaProvider.answer({ question, contextText }, signal);
  } catch (error) {
    if (error instanceof PageQaProviderError) throw new PageAskError(error.message, error.category);
    throw new PageAskError('Page Q&A failed unexpectedly.', 'ASK_FAILED');
  }
}

/**
 * "Ask About This Page" for a CURRENT_PAGE scan (the scan row itself IS the
 * one page — see migration 001's page_scans table, which CURRENT_PAGE scans
 * never populate). Reuses stores.getScanEvidenceForOrganizations for
 * retrieval/ownership (never a second, parallel auth mechanism), builds
 * bounded context via page-qa-context.ts, then calls the injected
 * PageQaProvider — mirrors repository-ai-service.ts's answerRepositoryQuestion
 * orchestration shape.
 */
export async function answerScanQuestion(
  stores: PageAskStores,
  scanId: string,
  organizationIds: string[],
  question: unknown,
  deps: PageAskDeps,
  signal?: AbortSignal,
): Promise<PageAskResponse> {
  const validQuestion = validateQuestion(question);
  const startedAt = Date.now();

  const scan = await stores.getScanEvidenceForOrganizations(scanId, organizationIds);
  if (!scan) throw new PageAskError('Scan not found.', 'SCAN_NOT_FOUND');
  if (!isReportReady(scan.status)) {
    throw new PageAskError(`This scan has not completed successfully (status: ${scan.status}).`, 'SCAN_NOT_READY');
  }

  const contextText = buildPageQaContext({
    url: scan.url,
    healthScore: scan.healthScore as HealthScore | undefined,
    issues: scan.issues,
    evidence: scan.fullEvidence,
  });

  const result = await callProvider(contextText, validQuestion, deps, signal);

  logPageAskCompleted({ scanId, issueCount: scan.issueCount, hasFullEvidence: Boolean(scan.fullEvidence), durationMs: Date.now() - startedAt });

  return {
    scanId,
    url: scan.url,
    answer: result.answer,
    healthScore: scan.healthScore as HealthScore | undefined,
    issueCount: scan.issueCount,
    model: result.model,
  };
}

/** Same shape as answerScanQuestion above, for one page of a WEBSITE scan. */
export async function answerPageScanQuestion(
  stores: PageAskStores,
  scanId: string,
  pageScanId: string,
  organizationIds: string[],
  question: unknown,
  deps: PageAskDeps,
  signal?: AbortSignal,
): Promise<PageAskResponse> {
  const validQuestion = validateQuestion(question);
  const startedAt = Date.now();

  const page = await stores.getPageScanEvidenceForOrganizations(scanId, pageScanId, organizationIds);
  if (!page) throw new PageAskError('Page scan not found.', 'PAGE_NOT_FOUND');
  if (!isReportReady(page.status)) {
    throw new PageAskError(`This page scan has not completed successfully (status: ${page.status}).`, 'SCAN_NOT_READY');
  }

  const contextText = buildPageQaContext({
    url: page.url,
    healthScore: page.healthScore as HealthScore | undefined,
    issues: page.issues,
    evidence: page.fullEvidence,
  });

  const result = await callProvider(contextText, validQuestion, deps, signal);

  logPageAskCompleted({ scanId, pageScanId, issueCount: page.issueCount, hasFullEvidence: Boolean(page.fullEvidence), durationMs: Date.now() - startedAt });

  return {
    scanId,
    pageScanId,
    url: page.url,
    answer: result.answer,
    healthScore: page.healthScore as HealthScore | undefined,
    issueCount: page.issueCount,
    model: result.model,
  };
}
