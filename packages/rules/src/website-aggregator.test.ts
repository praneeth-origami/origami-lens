import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Issue } from '@origami/contracts';
import { aggregateWebsiteIssues } from './website-aggregator.js';

function makeIssue(overrides: Partial<Issue> & Pick<Issue, 'category' | 'type' | 'severity' | 'title'>): Issue {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    category: overrides.category,
    type: overrides.type,
    severity: overrides.severity,
    title: overrides.title,
    evidence: overrides.evidence ?? {},
    confidence: 0.9,
    impact: 'impact',
    source: 'origami-rule',
    problem: overrides.problem ?? overrides.title,
    cause: 'cause',
    suggestedFix: 'fix',
    ruleId: overrides.ruleId,
    groupKey: overrides.groupKey,
  };
}

describe('aggregateWebsiteIssues', () => {
  it('groups by category rule and groupKey', () => {
    const issueA = makeIssue({
      category: 'seo',
      type: 'MISSING_TITLE',
      ruleId: 'SEO_MISSING_TITLE',
      severity: 'HIGH',
      title: 'Missing title',
      groupKey: 'missing-title',
    });
    const issueB = { ...issueA, id: crypto.randomUUID(), evidence: { url: '/about' } };

    const aggregated = aggregateWebsiteIssues([
      { pageScanId: 'p1', url: 'https://ex.com/', issues: [issueA] },
      { pageScanId: 'p2', url: 'https://ex.com/about', issues: [issueB] },
    ]);

    assert.equal(aggregated.length, 1);
    assert.equal(aggregated[0].occurrenceCount, 2);
    assert.equal(aggregated[0].affectedPages.length, 2);
    assert.equal(aggregated[0].occurrences.length, 2);
  });

  it('uses highest severity among occurrences', () => {
    const low = makeIssue({
      category: 'functional',
      type: 'CONSOLE_ERROR',
      ruleId: 'FUNC_CONSOLE_ERROR',
      severity: 'LOW',
      title: 'Console error',
      groupKey: 'console',
    });
    const critical = { ...low, id: crypto.randomUUID(), severity: 'CRITICAL' as const };

    const aggregated = aggregateWebsiteIssues([
      { pageScanId: 'p1', url: 'https://ex.com/a', issues: [low] },
      { pageScanId: 'p2', url: 'https://ex.com/b', issues: [critical] },
    ]);

    assert.equal(aggregated[0].severity, 'CRITICAL');
  });
});
