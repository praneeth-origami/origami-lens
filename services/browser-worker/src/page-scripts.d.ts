import type { BrowserEvidence } from '@origami/contracts';

export interface PageEvidenceResult {
  title: string;
  description: string;
  canonical: string;
  robots: string;
  viewportMeta: string;
  lang: string;
  documentDimensions: { width: number; height: number };
  viewport: { width: number; height: number };
  layout: BrowserEvidence['layout'];
  dom: BrowserEvidence['dom'];
  navigationTiming: Record<string, number>;
}

export function collectPageEvidence(): PageEvidenceResult;
export function collectLayoutEvidence(): BrowserEvidence['layout'];
export function runAxeInBrowser(): Promise<Record<string, unknown>>;
