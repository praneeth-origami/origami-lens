import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HealthScore, Issue, ScanResponse } from '@origami/contracts';
import {
  buildLensReport,
  isReportReady,
  reportFilename,
  renderReportCsv,
  renderReportJson,
  renderReportMarkdown,
  sanitizeHostnameForFilename,
} from './report-service.js';

function fakeHealthScore(overallScore = 78): HealthScore {
  return {
    overallScore,
    categories: {
      functional: { score: 84, weight: 25 },
      performance: { score: 71, weight: 20 },
      visualMobile: { score: 79, weight: 20 },
      accessibility: { score: 82, weight: 15 },
      bestPractices: { score: 76, weight: 10 },
      seo: { score: 68, weight: 5 },
      securityHygiene: { score: 91, weight: 5 },
    },
  };
}

function fakeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    category: 'accessibility',
    type: 'empty-button',
    severity: 'HIGH',
    title: 'Empty button',
    evidence: { selector: 'button.theme-option' },
    confidence: 0.9,
    impact: 'Screen reader users cannot tell what this button does.',
    source: 'axe-core',
    problem: 'The button does not have an accessible name.',
    cause: 'No aria-label or visible text was provided.',
    suggestedFix: 'Add an aria-label or visible text.',
    status: 'open',
    ...overrides,
  };
}

function fakeScan(overrides: Partial<ScanResponse> = {}): ScanResponse {
  return {
    scanId: 'scan-1',
    url: 'https://example.com',
    status: 'COMPLETED',
    healthScore: fakeHealthScore(),
    issues: [fakeIssue()],
    summary: { totalIssues: 1, critical: 0, high: 1, medium: 0, low: 0, aiAvailable: true },
    scannedAt: '2026-01-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('isReportReady', () => {
  it('is true only for COMPLETED / COMPLETED_WITH_WARNINGS', () => {
    assert.equal(isReportReady('COMPLETED'), true);
    assert.equal(isReportReady('COMPLETED_WITH_WARNINGS'), true);
    assert.equal(isReportReady('FAILED'), false);
    assert.equal(isReportReady('RUNNING'), false);
    assert.equal(isReportReady('QUEUED'), false);
    assert.equal(isReportReady('CANCELLED'), false);
    assert.equal(isReportReady(undefined), false);
  });
});

describe('buildLensReport', () => {
  it('copies the Health Score verbatim — never recalculates it', () => {
    const scan = fakeScan();
    const report = buildLensReport(scan);
    assert.equal(report.healthScore, scan.healthScore.overallScore);
    assert.equal(report.categories?.functional, scan.healthScore.categories.functional.score);
    assert.equal(report.categories?.securityHygiene, scan.healthScore.categories.securityHygiene.score);
  });

  it('carries the real reportVersion and scan identity through', () => {
    const report = buildLensReport(fakeScan());
    assert.equal(report.reportVersion, '1.0');
    assert.equal(report.scanId, 'scan-1');
    assert.equal(report.url, 'https://example.com');
  });

  it('maps issue fields faithfully, including selector from evidence', () => {
    const report = buildLensReport(fakeScan());
    assert.equal(report.issues.length, 1);
    const issue = report.issues[0];
    assert.equal(issue.title, 'Empty button');
    assert.equal(issue.severity, 'HIGH');
    assert.equal(issue.category, 'accessibility');
    assert.equal(issue.selector, 'button.theme-option');
    assert.equal(issue.status, 'open');
  });

  it('never fabricates a completed report for a FAILED/RUNNING/QUEUED scan — null scores, no issues', () => {
    for (const status of ['FAILED', 'RUNNING', 'QUEUED', 'CANCELLED'] as const) {
      const report = buildLensReport(fakeScan({ status }));
      assert.equal(report.healthScore, null, `status ${status} should have a null healthScore`);
      assert.equal(report.categories, null, `status ${status} should have null categories`);
      assert.deepEqual(report.issues, [], `status ${status} should have no issues`);
      assert.equal(report.reportStatus, status);
    }
  });

  it('scrubs sensitive-looking text out of free-text fields', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const scan = fakeScan({
      issues: [
        fakeIssue({
          problem: `Found a token ${jwt} in the response body.`,
          cause: 'Contact us at leaked@example.com for details.',
        }),
      ],
    });
    const report = buildLensReport(scan);
    const issue = report.issues[0];
    assert.ok(!issue.problem.includes(jwt), 'JWT-shaped strings must be scrubbed');
    assert.ok(!issue.cause.includes('leaked@example.com'), 'emails must be scrubbed');
  });
});

describe('renderReportJson', () => {
  it('round-trips to a valid LensReport with the right shape', () => {
    const report = buildLensReport(fakeScan());
    const parsed = JSON.parse(renderReportJson(report));
    assert.equal(parsed.reportVersion, '1.0');
    assert.equal(parsed.healthScore, 78);
    assert.equal(parsed.summary.high, 1);
    assert.equal(parsed.issues.length, 1);
  });
});

describe('renderReportMarkdown', () => {
  it('includes the website, health score, category table, and issue sections', () => {
    const md = renderReportMarkdown(buildLensReport(fakeScan()));
    assert.match(md, /# Origami Lens Report/);
    assert.match(md, /https:\/\/example\.com/);
    assert.match(md, /78 \/ 100/);
    assert.match(md, /\| Accessibility \| 82 \|/);
    assert.match(md, /### HIGH — Empty button/);
    assert.match(md, /\*\*Selector\*\*/);
  });

  it('reports an honest non-ready state instead of fabricating scores', () => {
    const md = renderReportMarkdown(buildLensReport(fakeScan({ status: 'FAILED' })));
    assert.match(md, /has not completed successfully/);
    assert.doesNotMatch(md, /\/ 100/);
  });
});

describe('renderReportCsv', () => {
  it('has the documented columns and one row per issue', () => {
    const csv = renderReportCsv(buildLensReport(fakeScan()));
    const [header, ...rows] = csv.split('\r\n');
    assert.equal(header, 'Issue ID,Title,Severity,Category,Status,URL,Selector,Problem,Cause,Impact,Suggested Fix');
    assert.equal(rows.length, 1);
    assert.match(rows[0], /^issue-1,Empty button,HIGH,Accessibility,open,/);
  });

  it('escapes commas, quotes, and newlines per RFC 4180', () => {
    const scan = fakeScan({ issues: [fakeIssue({ problem: 'Contains a, comma and "quotes" and\na newline.' })] });
    const csv = renderReportCsv(buildLensReport(scan));
    assert.ok(csv.includes('"Contains a, comma and ""quotes"" and\na newline."'));
  });
});

describe('sanitizeHostnameForFilename / reportFilename', () => {
  it('produces a safe, lowercase, hyphenated hostname', () => {
    assert.equal(sanitizeHostnameForFilename('https://Example.com/path?x=1'), 'example-com');
    assert.equal(sanitizeHostnameForFilename('https://sub.example.co.uk'), 'sub-example-co-uk');
  });

  it('falls back to "report" for an unparsable URL', () => {
    assert.equal(sanitizeHostnameForFilename('not a url'), 'not-a-url');
    assert.equal(sanitizeHostnameForFilename(''), 'report');
  });

  it('builds the documented filename shapes', () => {
    assert.equal(reportFilename('https://example.com', 'report', 'pdf'), 'origami-lens-example-com-report.pdf');
    assert.equal(reportFilename('https://example.com', 'issues', 'csv'), 'origami-lens-example-com-issues.csv');
  });
});
