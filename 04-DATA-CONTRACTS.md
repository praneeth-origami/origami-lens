# Data Contracts

## Scan Request

```json
{
  "url": "https://example.com",
  "title": "Example Website",
  "images": [],
  "links": [],
  "buttons": [],
  "forms": []
}
```

## Issue

```json
{
  "id": "issue-001",
  "type": "MISSING_IMAGE_ALT",
  "severity": "MINOR",
  "title": "Image is missing alt text",
  "evidence": {},
  "problem": "",
  "cause": "",
  "impact": "",
  "suggestedFix": ""
}
```

## Severity
- CRITICAL
- IMPORTANT
- MINOR
