import type { BrowserEvidence, Issue, ResponsiveTestErrorCode, ResponsiveTestResult, ResponsiveViewportResult } from '@origami/contracts';
import { DEFAULT_RESPONSIVE_WIDTHS } from '@origami/contracts';
import { OrigamiRuleEngine, IssueNormalizer } from '@origami/rules';

const BROWSER_WORKER_URL = process.env.BROWSER_WORKER_URL ?? 'http://localhost:3101';
/** Same ceiling as BrowserWorker.MAX_RESPONSIVE_WIDTHS — enforced here too so an invalid/oversized request never even reaches the browser worker. */
const MAX_WIDTHS = 8;

export class ResponsiveTestError extends Error {
  constructor(message: string, public readonly code: ResponsiveTestErrorCode) {
    super(message);
    this.name = 'ResponsiveTestError';
  }
}

interface BrowserWorkerViewport {
  width: number;
  dom: BrowserEvidence['dom'];
  layout: BrowserEvidence['layout'];
  viewport: BrowserEvidence['viewport'];
  screenshotBase64: string;
}

function labelForWidth(width: number, isLast: boolean): string {
  return isLast ? `${width}px (Desktop)` : `${width}px`;
}

/** Fills in every BrowserEvidence field the rule engine doesn't actually use for visualMobile rules (console/network/performance/screenshots/page/documentDimensions) with inert empty defaults — never invented content, just a shape the typed evaluate() call requires. */
function toEvaluableEvidence(url: string, viewport: BrowserWorkerViewport): BrowserEvidence {
  return {
    page: { url, title: '' },
    documentDimensions: viewport.viewport,
    viewport: viewport.viewport,
    dom: viewport.dom,
    layout: viewport.layout,
    console: [],
    network: [],
    performance: {},
    screenshots: [],
    collectedAt: new Date().toISOString(),
  };
}

/**
 * Automatic Responsive Testing (roadmap Phase 4). Renders `url` at each
 * requested width via the existing Playwright browser-worker
 * (scanResponsiveViewports), then evaluates the SAME existing
 * OrigamiRuleEngine/IssueNormalizer per width and filters to the
 * `visualMobile` category — never a parallel scoring/rule system. This is
 * an on-demand check, not a persisted scan: results are returned directly,
 * not written to the scans/page_scans tables.
 */
export async function runResponsiveTest(url: string, widths: number[] | undefined, signal?: AbortSignal): Promise<ResponsiveTestResult> {
  try {
    new URL(url);
  } catch {
    throw new ResponsiveTestError('url is not a valid URL', 'URL_INVALID');
  }

  const requestedWidths = (widths && widths.length > 0 ? widths : [...DEFAULT_RESPONSIVE_WIDTHS]).slice(0, MAX_WIDTHS);

  let viewports: BrowserWorkerViewport[];
  try {
    const response = await fetch(`${BROWSER_WORKER_URL}/scan/responsive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, widths: requestedWidths }),
      signal: signal ?? AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ResponsiveTestError((body as { error?: string }).error ?? `Browser worker returned HTTP ${response.status}`, 'RESPONSIVE_TEST_FAILED');
    }
    const data = (await response.json()) as { viewports: BrowserWorkerViewport[] };
    viewports = data.viewports;
  } catch (error) {
    if (error instanceof ResponsiveTestError) throw error;
    throw new ResponsiveTestError(error instanceof Error ? error.message : 'Browser worker unavailable.', 'BROWSER_WORKER_UNAVAILABLE');
  }

  const ruleEngine = new OrigamiRuleEngine();
  const normalizer = new IssueNormalizer();

  const results: ResponsiveViewportResult[] = viewports.map((vp, index) => {
    const evidence = toEvaluableEvidence(url, vp);
    let issues: Issue[] = ruleEngine.evaluate(evidence).filter((issue) => issue.category === 'visualMobile');
    issues = normalizer.normalize(issues);
    return {
      width: vp.width,
      label: labelForWidth(vp.width, index === viewports.length - 1),
      issues,
      issueCount: issues.length,
      screenshotBase64: vp.screenshotBase64 ?? '',
    };
  });

  return { url, viewports: results };
}
