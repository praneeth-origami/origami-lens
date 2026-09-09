import type { ScanStatus, WebsiteScanOptions } from '@origami/contracts';
import { DEFAULT_WEBSITE_MAX_PAGES, MAX_WEBSITE_PAGES } from '@origami/contracts';
import { discoverPages, isSameOrigin, UrlQueue } from '@origami/discovery';
import { aggregateWebsiteIssues } from '@origami/rules';
import { aggregateWebsiteHealthScore } from '@origami/scoring';
import { randomUUID } from 'node:crypto';
import { ScanRepository, resolveWebsiteOptions } from './db/scan-repository.js';
import { PageScanRunner } from './page-scan-runner.js';
import { IssueNormalizer } from '@origami/rules';

export class WebsiteScanOrchestrator {
  private repo: ScanRepository;
  private pageRunner: PageScanRunner;
  private normalizer = new IssueNormalizer();

  constructor(repo: ScanRepository, pageRunner: PageScanRunner) {
    this.repo = repo;
    this.pageRunner = pageRunner;
  }

  async runWebsiteScan(
    scanId: string,
    rootUrl: string,
    options: WebsiteScanOptions,
    ownerId?: string,
  ): Promise<void> {
    void ownerId;
    const resolved = resolveWebsiteOptions(options);
    const maxPages = Math.min(resolved.maxPages ?? DEFAULT_WEBSITE_MAX_PAGES, MAX_WEBSITE_PAGES);

    await this.repo.updateScanStatus(scanId, 'RUNNING');

    // Seeds the crawl (sitemap.xml -> robots.txt-referenced sitemap -> just
    // the root page). For AUTOMATIC, this is only the starting point: the
    // loop below extends it using each page's actually-rendered links, which
    // is what makes discovery work for client-rendered SPAs with no
    // server-rendered <a href> and no sitemap at all.
    const discovery = await discoverPages({
      rootUrl,
      method: resolved.discoveryMethod,
      maxPages,
      manualUrls: resolved.manualUrls,
    });

    if (discovery.urls.length === 0) {
      await this.repo.completeScan(scanId, {
        status: 'FAILED',
        scannedAt: new Date().toISOString(),
        error: discovery.error ?? 'No pages discovered',
      });
      return;
    }

    // Same queue instance is both the crawl frontier and the "seen" set —
    // queue.size is therefore always the true discovered-page count so far,
    // whether a URL came from the initial seed or a rendered link found
    // while scanning a later page.
    const queue = new UrlQueue(discovery.urls);
    const pageIdByUrl = await this.repo.createPageScans(scanId, discovery.urls);
    const canExpandViaRenderedLinks = resolved.discoveryMethod === 'AUTOMATIC';

    let completedPages = 0;
    let failedPages = 0;
    let issuesFound = 0;
    const pageIssuesForAggregation: Array<{ pageScanId: string; url: string; issues: import('@origami/contracts').Issue[] }> = [];
    const pageHealthScores: import('@origami/contracts').HealthScore[] = [];
    let anyAiAvailable = false;

    while (queue.pending > 0) {
      const url = queue.next()!;
      let pageScanId = pageIdByUrl.get(url);
      if (!pageScanId) {
        // Discovered via a rendered link after the initial seed batch.
        pageScanId = await this.repo.createPageScan(scanId, url);
        pageIdByUrl.set(url, pageScanId);
      }

      await this.repo.updateProgress(scanId, {
        discoveredPages: queue.size,
        completedPages,
        failedPages,
        issuesFound,
      });

      try {
        const result = await this.pageRunner.runPageScan(
          `${scanId}/${pageScanId}`,
          url,
          {
            includeScreenshots: resolved.includeScreenshots ?? false,
            mobileViewport: resolved.mobileViewport ?? true,
            runLighthouse: resolved.runLighthouse ?? false,
            runAxe: resolved.runAxe ?? true,
          },
          undefined,
          { skipAiSummary: true },
        );

        const scannedAt = new Date().toISOString();
        await this.repo.updatePageScan(pageScanId, {
          status: 'COMPLETED',
          healthScore: result.healthScore,
          evidenceSummary: result.evidenceSummary,
          artifacts: result.artifacts.screenshots.length > 0 ? result.artifacts : undefined,
          scannedAt,
        });
        await this.repo.savePageIssues(scanId, pageScanId, result.issues);

        pageIssuesForAggregation.push({ pageScanId, url, issues: result.issues });
        pageHealthScores.push(result.healthScore);
        issuesFound += result.issues.length;
        anyAiAvailable = anyAiAvailable || result.aiAvailable;
        completedPages++;

        if (canExpandViaRenderedLinks) {
          for (const link of result.discoveredLinks) {
            if (queue.size >= maxPages) break;
            if (isSameOrigin(link, rootUrl)) queue.add(link);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Page scan failed';
        await this.repo.updatePageScan(pageScanId, {
          status: 'FAILED',
          error: message,
        });
        failedPages++;
      }

      await this.repo.updateProgress(scanId, {
        discoveredPages: queue.size,
        completedPages,
        failedPages,
        issuesFound,
      });
    }

    if (completedPages === 0) {
      await this.repo.completeScan(scanId, {
        status: 'FAILED',
        scannedAt: new Date().toISOString(),
        error: 'All pages failed to scan',
      });
      return;
    }

    const aggregatedIssues = aggregateWebsiteIssues(pageIssuesForAggregation);
    await this.repo.saveAggregatedIssues(scanId, aggregatedIssues);

    const healthScore = aggregateWebsiteHealthScore(pageHealthScores);
    const bySeverity = this.normalizer.groupBySeverity(aggregatedIssues);

    const status: ScanStatus =
      failedPages > 0 ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED';

    await this.repo.completeScan(scanId, {
      status,
      healthScore: healthScore ?? undefined,
      summary: {
        totalIssues: aggregatedIssues.length,
        critical: bySeverity.CRITICAL.length,
        high: bySeverity.HIGH.length,
        medium: bySeverity.MEDIUM.length,
        low: bySeverity.LOW.length,
        aiAvailable: anyAiAvailable,
      },
      scannedAt: new Date().toISOString(),
    });
  }
}

export async function createWebsiteScanRecord(
  repo: ScanRepository,
  rootUrl: string,
  options: WebsiteScanOptions,
  ownerId?: string,
): Promise<string> {
  const scanId = randomUUID();
  const resolved = resolveWebsiteOptions(options);

  await repo.createScan({
    scanId,
    scanType: 'WEBSITE',
    rootUrl,
    ownerId,
    discoveryMethod: resolved.discoveryMethod,
    maxPages: resolved.maxPages,
    status: 'QUEUED',
  });

  return scanId;
}
