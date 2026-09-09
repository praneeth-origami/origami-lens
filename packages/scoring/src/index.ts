import type { HealthScore, Issue, IssueCategory } from '@origami/contracts';
import { CATEGORY_WEIGHTS, SEVERITY_DEDUCTIONS } from '@origami/contracts';

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

function computeCategoryScore(issues: Issue[]): number {
  let score = 100;
  const seen = new Set<string>();

  for (const issue of issues) {
    const dedupeKey = issue.groupKey ?? `${issue.ruleId ?? issue.type}:${issue.severity}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    score -= SEVERITY_DEDUCTIONS[issue.severity];
  }

  return clampScore(score);
}

export function calculateCategoryScores(issues: Issue[]): Record<IssueCategory, number> {
  const byCategory = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, [] as Issue[]])) as Record<IssueCategory, Issue[]>;

  for (const issue of issues) {
    byCategory[issue.category].push(issue);
  }

  return Object.fromEntries(
    ALL_CATEGORIES.map((category) => [category, computeCategoryScore(byCategory[category])]),
  ) as Record<IssueCategory, number>;
}

export function calculateOverallScore(categoryScores: Record<IssueCategory, number>): number {
  let weighted = 0;
  for (const category of ALL_CATEGORIES) {
    weighted += categoryScores[category] * (CATEGORY_WEIGHTS[category] / 100);
  }
  return clampScore(weighted);
}

export function calculateHealthScore(issues: Issue[]): HealthScore {
  const categoryScores = calculateCategoryScores(issues);
  const overallScore = calculateOverallScore(categoryScores);

  return {
    overallScore,
    categories: {
      functional: { score: categoryScores.functional, weight: CATEGORY_WEIGHTS.functional },
      performance: { score: categoryScores.performance, weight: CATEGORY_WEIGHTS.performance },
      visualMobile: { score: categoryScores.visualMobile, weight: CATEGORY_WEIGHTS.visualMobile },
      accessibility: { score: categoryScores.accessibility, weight: CATEGORY_WEIGHTS.accessibility },
      bestPractices: { score: categoryScores.bestPractices, weight: CATEGORY_WEIGHTS.bestPractices },
      seo: { score: categoryScores.seo, weight: CATEGORY_WEIGHTS.seo },
      securityHygiene: { score: categoryScores.securityHygiene, weight: CATEGORY_WEIGHTS.securityHygiene },
    },
  };
}

export class HealthScoreEngine {
  compute(issues: Issue[]): HealthScore {
    return calculateHealthScore(issues);
  }
}

export { aggregateWebsiteHealthScore } from './website-score.js';
