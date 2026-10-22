import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Issue } from '@origami/contracts';
import { PageAskError, answerPageScanQuestion, answerScanQuestion, type PageAskStores } from './page-qa-service.js';
import { PageQaProviderError, type PageQaProvider } from './page-qa-provider.js';

const HEALTH_SCORE = {
  overallScore: 62,
  categories: {
    functional: { score: 90, weight: 25 },
    performance: { score: 40, weight: 20 },
    visualMobile: { score: 70, weight: 20 },
    accessibility: { score: 55, weight: 15 },
    bestPractices: { score: 80, weight: 10 },
    seo: { score: 90, weight: 5 },
    securityHygiene: { score: 100, weight: 5 },
  },
};

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    category: 'performance',
    type: 'slow-lcp',
    severity: 'HIGH',
    title: 'Slow Largest Contentful Paint',
    evidence: {},
    confidence: 0.9,
    impact: 'Users perceive the page as slow.',
    source: 'lighthouse',
    problem: 'LCP is 4200ms.',
    cause: 'A large hero image loads without preloading.',
    suggestedFix: 'Preload the hero image and compress it.',
    ...overrides,
  };
}

function stubProvider(answer: string | Error, capture?: { question?: string; contextText?: string }): PageQaProvider {
  return {
    model: 'stub-model',
    async answer(request) {
      if (capture) Object.assign(capture, request);
      if (answer instanceof Error) throw answer;
      return { model: 'stub-model', answer };
    },
  };
}

describe('answerScanQuestion (CURRENT_PAGE)', () => {
  it('rejects an empty question with ASK_QUESTION_INVALID, before ever touching the store', async () => {
    let called = false;
    const stores: PageAskStores = {
      async getScanEvidenceForOrganizations() { called = true; return undefined; },
      async getPageScanEvidenceForOrganizations() { return undefined; },
    };
    await assert.rejects(
      () => answerScanQuestion(stores, 'scan-1', ['org-1'], '   ', { qaProvider: stubProvider('x') }),
      (error: unknown) => { assert.ok(error instanceof PageAskError); assert.equal(error.code, 'ASK_QUESTION_INVALID'); return true; },
    );
    assert.equal(called, false);
  });

  it('returns SCAN_NOT_FOUND when the store has no matching, organization-owned scan', async () => {
    const stores: PageAskStores = {
      async getScanEvidenceForOrganizations() { return undefined; },
      async getPageScanEvidenceForOrganizations() { return undefined; },
    };
    await assert.rejects(
      () => answerScanQuestion(stores, 'scan-1', ['org-1'], 'Why is this slow?', { qaProvider: stubProvider('x') }),
      (error: unknown) => { assert.ok(error instanceof PageAskError); assert.equal(error.code, 'SCAN_NOT_FOUND'); return true; },
    );
  });

  it('returns SCAN_NOT_READY for a scan that has not completed', async () => {
    const stores: PageAskStores = {
      async getScanEvidenceForOrganizations() {
        return { scanId: 'scan-1', url: 'https://example.com', status: 'RUNNING', issues: [], issueCount: 0 };
      },
      async getPageScanEvidenceForOrganizations() { return undefined; },
    };
    await assert.rejects(
      () => answerScanQuestion(stores, 'scan-1', ['org-1'], 'Why is this slow?', { qaProvider: stubProvider('x') }),
      (error: unknown) => { assert.ok(error instanceof PageAskError); assert.equal(error.code, 'SCAN_NOT_READY'); return true; },
    );
  });

  it('grounds the answer in the real issues/evidence for a completed scan, and returns healthScore/issueCount from the store', async () => {
    const capture: { question?: string; contextText?: string } = {};
    const stores: PageAskStores = {
      async getScanEvidenceForOrganizations(scanId, organizationIds) {
        assert.equal(scanId, 'scan-1');
        assert.deepEqual(organizationIds, ['org-1']);
        return {
          scanId: 'scan-1',
          url: 'https://example.com',
          status: 'COMPLETED',
          healthScore: HEALTH_SCORE,
          issues: [makeIssue()],
          issueCount: 1,
          fullEvidence: undefined,
        };
      },
      async getPageScanEvidenceForOrganizations() { return undefined; },
    };
    const response = await answerScanQuestion(stores, 'scan-1', ['org-1'], 'Why is this page slow?', { qaProvider: stubProvider('Grounded answer citing LCP.', capture) });

    assert.equal(response.scanId, 'scan-1');
    assert.equal(response.url, 'https://example.com');
    assert.equal(response.answer, 'Grounded answer citing LCP.');
    assert.deepEqual(response.healthScore, HEALTH_SCORE);
    assert.equal(response.issueCount, 1);
    assert.equal(response.model, 'stub-model');
    assert.equal(capture.question, 'Why is this page slow?');
    assert.match(capture.contextText!, /Slow Largest Contentful Paint/);
    assert.match(capture.contextText!, /LCP is 4200ms/);
  });

  it('still answers (with a narrower context) when no full evidence was ever captured for this scan', async () => {
    const capture: { contextText?: string } = {};
    const stores: PageAskStores = {
      async getScanEvidenceForOrganizations() {
        return { scanId: 'scan-1', url: 'https://example.com', status: 'COMPLETED_WITH_WARNINGS', issues: [], issueCount: 0, fullEvidence: undefined };
      },
      async getPageScanEvidenceForOrganizations() { return undefined; },
    };
    const response = await answerScanQuestion(stores, 'scan-1', ['org-1'], 'What is broken?', { qaProvider: stubProvider('No detailed evidence available.', capture) });
    assert.equal(response.answer, 'No detailed evidence available.');
    assert.match(capture.contextText!, /No detailed page evidence is available/);
  });

  it('maps a PageQaProviderError from the provider onto the matching PageAskError code', async () => {
    const stores: PageAskStores = {
      async getScanEvidenceForOrganizations() {
        return { scanId: 'scan-1', url: 'https://example.com', status: 'COMPLETED', issues: [], issueCount: 0 };
      },
      async getPageScanEvidenceForOrganizations() { return undefined; },
    };
    await assert.rejects(
      () => answerScanQuestion(stores, 'scan-1', ['org-1'], 'q', { qaProvider: stubProvider(new PageQaProviderError('timed out', 'LLM_TIMEOUT')) }),
      (error: unknown) => { assert.ok(error instanceof PageAskError); assert.equal(error.code, 'LLM_TIMEOUT'); return true; },
    );
  });
});

describe('answerPageScanQuestion (WEBSITE scan page)', () => {
  it('returns PAGE_NOT_FOUND when the store has no matching page', async () => {
    const stores: PageAskStores = {
      async getScanEvidenceForOrganizations() { return undefined; },
      async getPageScanEvidenceForOrganizations() { return undefined; },
    };
    await assert.rejects(
      () => answerPageScanQuestion(stores, 'scan-1', 'page-1', ['org-1'], 'q', { qaProvider: stubProvider('x') }),
      (error: unknown) => { assert.ok(error instanceof PageAskError); assert.equal(error.code, 'PAGE_NOT_FOUND'); return true; },
    );
  });

  it('grounds the answer in the page_scans row (not the parent scan) for a completed page', async () => {
    const capture: { contextText?: string } = {};
    const stores: PageAskStores = {
      async getScanEvidenceForOrganizations() { return undefined; },
      async getPageScanEvidenceForOrganizations(scanId, pageScanId, organizationIds) {
        assert.equal(scanId, 'scan-1');
        assert.equal(pageScanId, 'page-1');
        assert.deepEqual(organizationIds, ['org-1']);
        return {
          pageScanId: 'page-1',
          url: 'https://example.com/checkout',
          status: 'COMPLETED',
          healthScore: HEALTH_SCORE,
          issues: [makeIssue({ title: 'Checkout button has no accessible name', category: 'accessibility' })],
          issueCount: 1,
        };
      },
    };
    const response = await answerPageScanQuestion(stores, 'scan-1', 'page-1', ['org-1'], 'Is anything wrong with checkout?', { qaProvider: stubProvider('The checkout button lacks an accessible name.', capture) });
    assert.equal(response.scanId, 'scan-1');
    assert.equal(response.pageScanId, 'page-1');
    assert.equal(response.url, 'https://example.com/checkout');
    assert.match(capture.contextText!, /Checkout button has no accessible name/);
  });
});
