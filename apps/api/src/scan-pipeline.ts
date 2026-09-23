import type { ScanRequest, ScanResponse } from '@origami/contracts';
import { IssueNormalizer } from '@origami/rules';
import { randomUUID } from 'node:crypto';
import { PageScanRunner } from './page-scan-runner.js';
import { UnifiedScanStore } from './unified-scan-store.js';

const AI_ROUTER_URL = process.env.AI_ROUTER_URL ?? 'http://localhost:3102';

export class ScanPipeline {
  private pageRunner = new PageScanRunner();
  private normalizer = new IssueNormalizer();
  private store = new UnifiedScanStore();

  getStore(): UnifiedScanStore {
    return this.store;
  }

  getArtifactStore() {
    return this.pageRunner.getArtifactStore();
  }

  getPageRunner(): PageScanRunner {
    return this.pageRunner;
  }

  async runScan(request: ScanRequest, organizationId?: string): Promise<ScanResponse> {
    const scanId = randomUUID();
    const url = request.url;
    const scannedAt = new Date().toISOString();

    const result = await this.pageRunner.runPageScan(
      scanId,
      url,
      request.options,
      request.pageEvidence,
    );

    const bySeverity = this.normalizer.groupBySeverity(result.issues);

    const response: ScanResponse = {
      scanId,
      url,
      scanType: 'CURRENT_PAGE',
      status: 'COMPLETED',
      healthScore: result.healthScore,
      issues: result.issues,
      summary: {
        totalIssues: result.issues.length,
        critical: bySeverity.CRITICAL.length,
        high: bySeverity.HIGH.length,
        medium: bySeverity.MEDIUM.length,
        low: bySeverity.LOW.length,
        aiAvailable: result.aiAvailable,
      },
      scannedAt,
      artifacts: result.artifacts.screenshots.length > 0 ? result.artifacts : undefined,
      aiSummary: result.aiSummary,
      evidenceSummary: result.evidenceSummary,
      progress: {
        discoveredPages: 1,
        completedPages: 1,
        failedPages: 0,
        issuesFound: result.issues.length,
      },
      ownerId: request.ownerId,
      organizationId,
    };

    this.store.saveScan(response);
    return response;
  }

  async explainIssue(issue: import('@origami/contracts').Issue, evidence?: Partial<import('@origami/contracts').BrowserEvidence>) {
    const response = await fetch(`${AI_ROUTER_URL}/explain-issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue, evidence }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      return {
        explanation: {
          problem: issue.problem,
          cause: issue.cause,
          impact: issue.impact,
          suggestedFix: issue.suggestedFix,
          confidence: issue.confidence,
        },
        aiAvailable: false,
        error: 'AI explanation unavailable.',
      };
    }

    return response.json();
  }
}
