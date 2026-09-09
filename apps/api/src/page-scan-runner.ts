import type {
  AiScanSummary,
  BrowserEvidence,
  EvidenceSummary,
  Issue,
  IssueCategory,
  IssueStatus,
  PageScanOptions,
  ScanArtifacts,
  Severity,
} from '@origami/contracts';
import { PrivacyScrubber } from '@origami/privacy';
import { OrigamiRuleEngine, IssueNormalizer } from '@origami/rules';
import { HealthScoreEngine } from '@origami/scoring';
import { extractLinksFromDom } from '@origami/discovery';
import { randomUUID } from 'node:crypto';
import { ArtifactStore } from './artifact-store.js';

const BROWSER_WORKER_URL = process.env.BROWSER_WORKER_URL ?? 'http://localhost:3101';
const AI_ROUTER_URL = process.env.AI_ROUTER_URL ?? 'http://localhost:3102';

interface VisualFinding {
  title?: string;
  problem?: string;
  cause?: string;
  impact?: string;
  suggestedFix?: string;
  severity?: string;
  confidence?: number;
}

export interface PageScanResult {
  issues: Issue[];
  healthScore: ReturnType<HealthScoreEngine['compute']>;
  artifacts: ScanArtifacts;
  evidenceSummary: EvidenceSummary;
  aiSummary?: AiScanSummary;
  aiAvailable: boolean;
  /**
   * Same-page-rendered links (normalized, absolute), extracted from the
   * actually-rendered DOM the Browser Engine collected — not the raw HTTP
   * response. This is what makes multi-page discovery work for
   * client-rendered SPAs (React/Next.js/Vue/Angular), whose navigation links
   * only exist after JavaScript executes and are invisible to a plain fetch.
   * Same-origin filtering and deduplication happen in the caller
   * (website-scan-orchestrator.ts), which also knows the crawl's root origin
   * and page budget.
   */
  discoveredLinks: string[];
}

export class PageScanRunner {
  private ruleEngine = new OrigamiRuleEngine();
  private normalizer = new IssueNormalizer();
  private healthScoreEngine = new HealthScoreEngine();
  private privacyScrubber = new PrivacyScrubber();
  private artifactStore = new ArtifactStore();

  getArtifactStore(): ArtifactStore {
    return this.artifactStore;
  }

  async runPageScan(
    scanId: string,
    url: string,
    options?: PageScanOptions,
    pageEvidence?: Partial<BrowserEvidence>,
    opts?: { skipAiSummary?: boolean },
  ): Promise<PageScanResult> {
    const scannedAt = new Date().toISOString();

    let evidence = await this.collectEvidence(url, options, pageEvidence);
    // Extracted from the raw, pre-sanitization DOM snapshot — link hrefs are
    // not sensitive content, but computed here rather than after
    // privacyScrubber.sanitize() to stay independent of what that scrubber
    // does to other DOM fields over time.
    const discoveredLinks = extractLinksFromDom(
      (evidence.dom.links ?? []).map((l) => ({ attributes: l.attributes })),
      url,
    );
    const artifacts = this.persistArtifacts(scanId, evidence);
    evidence = this.stripScreenshotBase64(evidence);
    evidence = this.privacyScrubber.sanitize(evidence);
    const evidenceSummary = this.buildEvidenceSummary(evidence);

    let issues = this.ruleEngine.evaluate(evidence);
    issues = this.normalizer.normalize(issues);

    const { visionIssues, aiAvailable: visionAiAvailable } = await this.runVisualQa(scanId, url, artifacts);
    if (visionIssues.length > 0) {
      issues = this.normalizer.normalize([...issues, ...visionIssues]);
    }

    issues = issues.map((issue) => ({
      ...issue,
      scanId,
      url,
      status: 'open' as IssueStatus,
      createdAt: scannedAt,
    }));

    const healthScore = this.healthScoreEngine.compute(issues);
    let aiAvailable = visionAiAvailable;
    let aiSummary: AiScanSummary | undefined;

    if (!opts?.skipAiSummary) {
      try {
        const summaryResponse = await fetch(`${AI_ROUTER_URL}/gateway`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task: 'summarize_scan',
            payload: { url, issues: issues.slice(0, 20), healthScore: healthScore.overallScore },
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (summaryResponse.ok) {
          const data = (await summaryResponse.json()) as {
            success: boolean;
            model?: string;
            result?: Record<string, unknown>;
          };
          const usedAi = data.success && data.model !== 'deterministic-fallback';
          aiAvailable = aiAvailable || usedAi;
          if (data.result) {
            aiSummary = {
              summary: String(data.result.summary ?? ''),
              topIssues: (data.result.topIssues as string[]) ?? [],
              recommendations: (data.result.recommendations as string[]) ?? [],
            };
          }
        }
      } catch {
        // Non-fatal
      }
    }

    return {
      issues,
      healthScore,
      artifacts: artifacts.screenshots.length > 0 ? artifacts : { screenshots: [] },
      evidenceSummary,
      aiSummary,
      aiAvailable,
      discoveredLinks,
    };
  }

  private persistArtifacts(scanId: string, evidence: BrowserEvidence): ScanArtifacts {
    const stored = this.artifactStore.saveScreenshots(scanId, evidence.screenshots);
    return { screenshots: stored };
  }

  private stripScreenshotBase64(evidence: BrowserEvidence): BrowserEvidence {
    return {
      ...evidence,
      screenshots: evidence.screenshots.map(({ base64: _b, ...rest }) => rest),
    };
  }

  private buildEvidenceSummary(evidence: BrowserEvidence): EvidenceSummary {
    const consoleErrors = evidence.console.filter(
      (e) => e.type === 'error' || e.type === 'exception',
    ).length;
    const failedRequests = evidence.network.filter((n) => n.failed).length;

    let lighthousePerformanceScore: number | undefined;
    const categories = evidence.lighthouse?.categories as
      | Record<string, { score?: number }>
      | undefined;
    if (categories?.performance?.score !== undefined) {
      lighthousePerformanceScore = Math.round(categories.performance.score * 100);
    }

    return { consoleErrors, failedRequests, lighthousePerformanceScore };
  }

  private async runVisualQa(
    scanId: string,
    url: string,
    artifacts: ScanArtifacts,
  ): Promise<{ visionIssues: Issue[]; aiAvailable: boolean }> {
    if (artifacts.screenshots.length === 0) {
      return { visionIssues: [], aiAvailable: false };
    }

    const visionIssues: Issue[] = [];
    let aiAvailable = false;

    for (const shot of artifacts.screenshots) {
      const base64 = this.artifactStore.readArtifactBase64(scanId, shot.storageKey);
      if (!base64) continue;

      try {
        const response = await fetch(`${AI_ROUTER_URL}/gateway`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task: 'visual_qa',
            payload: {
              url,
              viewport: shot.viewport,
              imageBase64: base64,
              width: shot.width,
              height: shot.height,
            },
          }),
          signal: AbortSignal.timeout(45000),
        });

        if (!response.ok) continue;

        const data = (await response.json()) as {
          success: boolean;
          model?: string;
          result?: Record<string, unknown>;
        };

        if (data.model !== 'deterministic-fallback') {
          aiAvailable = true;
        }

        const findings = (data.result?.findings as VisualFinding[]) ?? [];
        for (const finding of findings) {
          const issue = this.findingToIssue(finding, shot.viewport);
          if (issue) visionIssues.push(issue);
        }
      } catch {
        // Non-fatal
      }
    }

    return { visionIssues, aiAvailable };
  }

  private findingToIssue(finding: VisualFinding, viewport: 'desktop' | 'mobile'): Issue | null {
    if (!finding.title && !finding.problem) return null;

    const severity = this.parseSeverity(finding.severity);

    return {
      id: randomUUID(),
      category: 'visualMobile' as IssueCategory,
      type: 'vision-ai-finding',
      severity,
      title: finding.title ?? 'Visual issue detected',
      evidence: { viewport: { width: 0, height: 0 }, message: finding.problem, metric: viewport },
      confidence: finding.confidence ?? 0.7,
      impact: finding.impact ?? 'May affect visual quality or mobile usability.',
      source: 'vision-ai',
      problem: finding.problem ?? finding.title ?? 'Visual issue detected',
      cause: finding.cause ?? 'Identified via visual analysis of page screenshot.',
      suggestedFix: finding.suggestedFix ?? 'Review layout and styling for the affected viewport.',
      groupKey: `vision-ai:${finding.title ?? finding.problem}`,
    };
  }

  private parseSeverity(value?: string): Severity {
    const upper = (value ?? 'HIGH').toUpperCase();
    if (upper === 'CRITICAL') return 'CRITICAL';
    if (upper === 'HIGH' || upper === 'IMPORTANT') return 'HIGH';
    if (upper === 'MEDIUM' || upper === 'MODERATE') return 'MEDIUM';
    if (upper === 'LOW' || upper === 'MINOR') return 'LOW';
    return 'HIGH';
  }

  private async collectEvidence(
    url: string,
    options?: PageScanOptions,
    pageEvidence?: Partial<BrowserEvidence>,
  ): Promise<BrowserEvidence> {
    // Captures the browser worker's OWN error — a genuine navigation/render
    // failure with a specific cause (e.g. a Playwright timeout) — separately
    // from "the process itself never answered". Both fall back to extension
    // evidence the same way, but if there is none, the real reason must
    // surface instead of a generic message that wrongly implies the worker
    // is down when it responded with a specific, diagnosable error.
    let browserWorkerError: string | undefined;

    try {
      const response = await fetch(`${BROWSER_WORKER_URL}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          options: options ?? {
            includeScreenshots: true,
            mobileViewport: true,
            runLighthouse: true,
            runAxe: true,
          },
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (response.ok) {
        const data = (await response.json()) as { evidence: BrowserEvidence };
        return data.evidence;
      }

      const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
      browserWorkerError = body?.error ?? `Browser worker returned HTTP ${response.status}`;
    } catch (error) {
      browserWorkerError = error instanceof Error ? error.message : 'Browser worker request failed';
    }

    if (pageEvidence && this.hasMinimalEvidence(pageEvidence)) {
      return this.mergeExtensionEvidence(url, pageEvidence);
    }

    throw new Error(browserWorkerError ?? 'Browser worker unavailable and no extension evidence provided.');
  }

  private hasMinimalEvidence(partial: Partial<BrowserEvidence>): boolean {
    return Boolean(partial.page?.title !== undefined && partial.dom);
  }

  private mergeExtensionEvidence(url: string, partial: Partial<BrowserEvidence>): BrowserEvidence {
    const now = new Date().toISOString();
    return {
      page: {
        url,
        title: partial.page?.title ?? '',
        description: partial.page?.description,
        canonical: partial.page?.canonical,
        robots: partial.page?.robots,
        viewport: partial.page?.viewport,
        lang: partial.page?.lang,
      },
      documentDimensions: partial.documentDimensions ?? { width: 0, height: 0 },
      viewport: partial.viewport ?? { width: 1280, height: 720 },
      dom: partial.dom ?? { headings: [], images: [], links: [], buttons: [], forms: [], iframes: [] },
      layout: partial.layout ?? { horizontalOverflow: false, elementsOutsideViewport: [], fixedWidthElements: [] },
      console: partial.console ?? [],
      network: partial.network ?? [],
      performance: partial.performance ?? {},
      screenshots: partial.screenshots ?? [],
      collectedAt: partial.collectedAt ?? now,
    };
  }
}
