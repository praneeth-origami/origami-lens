import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterIssues, countIssuesByCategory } from './scan-store.js';
import type { Issue } from '@origami/contracts';

function issue(partial: Partial<Issue> & Pick<Issue, 'severity' | 'category'>): Issue {
  return {
    id: partial.id ?? '1',
    type: 'TEST',
    title: partial.title ?? 'Test issue',
    evidence: {},
    confidence: 1,
    impact: 'test',
    source: 'origami-rule',
    problem: 'problem',
    cause: 'cause',
    suggestedFix: 'fix',
    status: 'open',
    createdAt: '2026-09-04T00:00:00Z',
    ...partial,
  };
}

describe('filterIssues', () => {
  const issues = [
    issue({ id: '1', severity: 'CRITICAL', category: 'functional', title: 'Checkout error' }),
    issue({ id: '2', severity: 'LOW', category: 'seo', title: 'Missing description' }),
    issue({ id: '3', severity: 'HIGH', category: 'accessibility', title: 'Missing label', status: 'resolved' }),
  ];

  it('filters by severity', () => {
    const result = filterIssues(issues, { severity: 'CRITICAL' });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '1');
  });

  it('filters by category', () => {
    const result = filterIssues(issues, { category: 'seo' });
    assert.equal(result.length, 1);
  });

  it('filters by status', () => {
    const result = filterIssues(issues, { status: 'resolved' });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '3');
  });

  it('searches title and problem', () => {
    const result = filterIssues(issues, { search: 'checkout' });
    assert.equal(result.length, 1);
  });
});

describe('countIssuesByCategory', () => {
  it('counts per category', () => {
    const counts = countIssuesByCategory([
      issue({ severity: 'LOW', category: 'seo' }),
      issue({ severity: 'LOW', category: 'seo' }),
      issue({ severity: 'CRITICAL', category: 'functional' }),
    ]);
    assert.equal(counts.seo, 2);
    assert.equal(counts.functional, 1);
  });
});
