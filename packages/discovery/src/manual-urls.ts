import { isSameOrigin } from './same-origin.js';
import { normalizeUrl } from './url-normalize.js';

export interface ManualUrlResult {
  urls: string[];
  invalid: string[];
}

export function validateManualUrls(manualUrls: string[], rootUrl: string): ManualUrlResult {
  const urls: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const raw of manualUrls) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const normalized = normalizeUrl(trimmed, rootUrl);
    if (!normalized) {
      invalid.push(trimmed);
      continue;
    }

    if (!isSameOrigin(normalized, rootUrl)) {
      invalid.push(trimmed);
      continue;
    }

    if (!seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }

  return { urls, invalid };
}

export function parseManualUrlLines(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}
