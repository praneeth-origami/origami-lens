import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateHealthScore } from './index.js';
import type { Issue } from '@origami/contracts';

function makeIssue(partial: Partial<Issue> & Pick<Issue, 'category' | 'severity'>): Issue {
  return {
    id: '1',
    type: 'TEST',
    title: 'Test',
    evidence: {},
    confidence: 1,
    impact: 'test',
    source: 'origami-rule',
    problem: '',
    cause: '',
    suggestedFix: '',
    ...partial,
  };
}

describe('HealthScoreEngine', () => {
  it('starts at 100 with no issues', () => {
    const score = calculateHealthScore([]);
    assert.equal(score.overallScore, 100);
    assert.equal(score.categories.functional.score, 100);
  });

  it('applies category weights correctly', () => {
    const score = calculateHealthScore([
      makeIssue({ category: 'functional', severity: 'CRITICAL', ruleId: 'FUNC_CONSOLE_ERROR' }),
    ]);
    assert.equal(score.categories.functional.score, 90);
    assert.equal(score.overallScore, 97.5); // 90 * 0.25 + 100 * 0.75
  });

  it('deduplicates by groupKey within category', () => {
    const score = calculateHealthScore([
      makeIssue({ category: 'accessibility', severity: 'LOW', groupKey: 'missing-alt', ruleId: 'A11Y_MISSING_ALT' }),
      makeIssue({ category: 'accessibility', severity: 'LOW', groupKey: 'missing-alt', ruleId: 'A11Y_MISSING_ALT' }),
    ]);
    assert.equal(score.categories.accessibility.score, 98);
  });

  it('clamps scores between 0 and 100', () => {
    const issues = Array.from({ length: 20 }, (_, i) =>
      makeIssue({ category: 'functional', severity: 'CRITICAL', ruleId: `r-${i}` }),
    );
    const score = calculateHealthScore(issues);
    assert.equal(score.categories.functional.score, 0);
    assert.ok(score.overallScore >= 0 && score.overallScore <= 100);
  });
});
