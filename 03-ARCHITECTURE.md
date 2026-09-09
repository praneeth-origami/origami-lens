# MVP Architecture

```text
Chrome Extension
      ↓
Inspect Page
      ↓
Content Script Collects Evidence
      ↓
Backend API
      ↓
Rule Engine
      ↓
Issue Normalizer
      ↓
Health Score
      ↓
AI Explanation / Suggested Fix
      ↓
Extension Results UI
```

## Extension
- Trigger scan
- Collect webpage data
- Send scan request
- Display results

## Backend
- Validate scan data
- Run deterministic rules
- Normalize issues
- Calculate health score
- Request AI explanation

## Important Rule
Send only relevant issue context to AI.
