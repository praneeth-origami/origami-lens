import type { HealthScore, IssueCategory } from '@origami/contracts';
import { CATEGORY_WEIGHTS } from '@origami/contracts';
import { calculateOverallScore } from './index.js';

const ALL_CATEGORIES: IssueCategory[] = [
  'functional',
  'performance',
  'visualMobile',
  'accessibility',
  'bestPractices',
  'seo',
  'securityHygiene',
];

function clampScore(score: number): number {
  return Math.min(100, Math.max(0, Math.round(score * 10) / 10));
}

export function aggregateWebsiteHealthScore(pageScores: HealthScore[]): HealthScore | null {
  if (pageScores.length === 0) return null;

  const categoryAverages = {} as Record<IssueCategory, number>;

  for (const category of ALL_CATEGORIES) {
    const scores = pageScores.map((ps) => ps.categories[category].score);
    const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
    categoryAverages[category] = clampScore(avg);
  }

  const overallScore = calculateOverallScore(categoryAverages);

  return {
    overallScore,
    categories: {
      functional: { score: categoryAverages.functional, weight: CATEGORY_WEIGHTS.functional },
      performance: { score: categoryAverages.performance, weight: CATEGORY_WEIGHTS.performance },
      visualMobile: { score: categoryAverages.visualMobile, weight: CATEGORY_WEIGHTS.visualMobile },
      accessibility: { score: categoryAverages.accessibility, weight: CATEGORY_WEIGHTS.accessibility },
      bestPractices: { score: categoryAverages.bestPractices, weight: CATEGORY_WEIGHTS.bestPractices },
      seo: { score: categoryAverages.seo, weight: CATEGORY_WEIGHTS.seo },
      securityHygiene: {
        score: categoryAverages.securityHygiene,
        weight: CATEGORY_WEIGHTS.securityHygiene,
      },
    },
  };
}
