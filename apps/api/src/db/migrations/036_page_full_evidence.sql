-- "Ask About This Page" — persists the full, already privacy-scrubbed and
-- screenshot-stripped BrowserEvidence object captured at scan time (see
-- page-scan-runner.ts's runPageScan/stripScreenshotBase64/privacyScrubber),
-- so a later grounded question can be answered from that scan's real
-- evidence without re-scraping the live page or accepting client-supplied
-- evidence. Nullable and never backfilled: a scan that ran before this
-- migration simply has no full evidence to ask about, which is correct —
-- see page-qa-service.ts's EVIDENCE_UNAVAILABLE handling.

ALTER TABLE scans ADD COLUMN IF NOT EXISTS full_evidence_json JSONB;
ALTER TABLE page_scans ADD COLUMN IF NOT EXISTS full_evidence_json JSONB;
