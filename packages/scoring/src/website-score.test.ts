import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HealthScore } from '@origami/contracts';
import { aggregateWebsiteHealthScore } from './website-score.js';

function makePageScore(overall: number, functional: number): HealthScore {
  return {
    overallScore: overall,
    categories: {
      functional: { score: functional, weight: 25 },
      performance: { score: 80, weight: 20 },
      visualMobile: { score: 80, weight: 20 },
      accessibility: { score: 80, weight: 15 },
      bestPractices: { score: 80, weight: 10 },
      seo: { score: 80, weight: 5 },
      securityHygiene: { score: 80, weight: 5 },
    },
  };
}

describe('aggregateWebsiteHealthScore', () => {
  it('averages category scores across pages', () => {
    const result = aggregateWebsiteHealthScore([
      makePageScore(90, 100),
      makePageScore(70, 60),
    ]);

    assert.ok(result);
    assert.equal(result!.categories.functional.score, 80);
  });

  it('returns null for empty input', () => {
    assert.equal(aggregateWebsiteHealthScore([]), null);
  });
});
