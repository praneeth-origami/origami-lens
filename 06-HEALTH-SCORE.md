# Health Score

Start every category at 100. Overall score is a weighted average of category scores.

## Severity deductions (per unique issue in a category)

| Severity | Deduction |
|----------|-----------|
| Critical | −10 |
| High     | −7  |
| Medium   | −4  |
| Low      | −2  |

Minimum score: 0. Maximum score: 100.

## Category weights

| Category         | Weight |
|------------------|--------|
| Functional       | 25%    |
| Performance      | 20%    |
| Visual/Mobile    | 20%    |
| Accessibility    | 15%    |
| Best Practices   | 10%    |
| SEO              | 5%     |
| Security Hygiene | 5%     |

## Rules

- Score must be deterministic.
- AI must not generate the score.
- Avoid duplicate deductions for duplicate issues (dedupe by `groupKey`).

```text
categoryScore = 100
for each unique issue in category:
    deduct points by severity
categoryScore = clamp(categoryScore, 0, 100)

overallScore = sum(categoryScore * weight / 100)
```
