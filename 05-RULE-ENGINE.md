# Rule Engine

## Principle
Rules detect facts. AI explains facts.

## Initial Rules

### Missing Page Title
Condition: document.title is empty.
Severity: IMPORTANT.

### Missing Image Alt Text
Condition: an image is missing an alt attribute.
Severity: MINOR.

### Empty Link
Condition: link has an empty or unusable href.
Severity: MINOR.

### Empty Button
Condition: button has no visible text and no accessible name.
Severity: IMPORTANT.

### Missing Form Label
Condition: interactive input has no associated label or accessible name.
Severity: IMPORTANT.

## Every Rule Returns
- Rule ID
- Issue type
- Severity
- Title
- Evidence
