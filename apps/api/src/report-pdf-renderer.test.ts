import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LensReport } from '@origami/contracts';
import { renderReportPdf } from './report-pdf-renderer.js';

function fakeReport(overrides: Partial<LensReport> = {}): LensReport {
  return {
    reportVersion: '1.0',
    generatedAt: '2026-01-01T00:00:00.000Z',
    scanId: 'scan-1',
    url: 'https://example.com',
    reportStatus: 'COMPLETED',
    scannedAt: '2026-01-01T00:00:00.000Z',
    healthScore: 78,
    categories: {
      functional: 84,
      performance: 71,
      visualMobile: 79,
      accessibility: 82,
      bestPractices: 76,
      seo: 68,
      securityHygiene: 91,
    },
    summary: { critical: 0, high: 3, medium: 8, low: 14 },
    issues: [
      {
        id: 'issue-1',
        title: 'Empty button',
        severity: 'HIGH',
        category: 'accessibility',
        status: 'open',
        problem: 'The button does not have an accessible name.',
        cause: 'No aria-label or visible text was provided.',
        impact: 'Screen reader users cannot tell what this button does.',
        suggestedFix: 'Add an aria-label or visible text.',
        url: 'https://example.com',
        selector: 'button.theme-option',
      },
    ],
    ...overrides,
  };
}

describe('renderReportPdf', () => {
  it('produces a real, non-empty PDF document', async () => {
    const buffer = await renderReportPdf(fakeReport());
    assert.ok(buffer.length > 500, 'PDF should have real content, not just a header');
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(buffer.subarray(buffer.length - 7).toString('latin1').trim(), '%%EOF');
  });

  it('still produces a valid, small document for a non-ready scan (no fabricated score section)', async () => {
    const buffer = await renderReportPdf(fakeReport({ reportStatus: 'FAILED', healthScore: null, categories: null, issues: [] }));
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(buffer.length > 200);
  });

  it('handles many issues across multiple pages without throwing', async () => {
    const manyIssues = Array.from({ length: 40 }, (_, i) => ({
      id: `issue-${i}`,
      title: `Issue number ${i}`,
      severity: 'MEDIUM' as const,
      category: 'seo' as const,
      problem: 'Problem text.',
      cause: 'Cause text.',
      impact: 'Impact text.',
      suggestedFix: 'Fix text.',
    }));
    const buffer = await renderReportPdf(fakeReport({ issues: manyIssues }));
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(buffer.length > 2000);
  });
});
