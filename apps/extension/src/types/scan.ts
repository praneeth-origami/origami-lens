/// <reference types="chrome" />

export interface PageEvidenceMessage {
  type: 'COLLECT_EVIDENCE';
}

export interface EvidencePayload {
  page: {
    url: string;
    title: string;
    description?: string;
    canonical?: string;
  };
  documentDimensions: { width: number; height: number };
  viewport: { width: number; height: number };
  dom: {
    headings: Array<{ selector: string; tag: string; text?: string; attributes: Record<string, string> }>;
    images: Array<{ selector: string; tag: string; attributes: Record<string, string> }>;
    links: Array<{ selector: string; tag: string; text?: string; attributes: Record<string, string> }>;
    buttons: Array<{ selector: string; tag: string; text?: string; attributes: Record<string, string> }>;
    forms: Array<{ selector: string; tag: string; attributes: Record<string, string> }>;
    iframes: Array<{ selector: string; tag: string; attributes: Record<string, string> }>;
  };
  layout: {
    horizontalOverflow: boolean;
    overflowWidth?: number;
    elementsOutsideViewport: unknown[];
    fixedWidthElements: unknown[];
  };
  collectedAt: string;
}

export interface ScanResult {
  scanId: string;
  url: string;
  scanType?: string;
  healthScore: {
    overallScore: number;
    categories: Record<string, { score: number; weight: number }>;
  };
  issues: Array<{
    id: string;
    category: string;
    type: string;
    severity: string;
    title: string;
    evidence: Record<string, unknown>;
    confidence: number;
    impact: string;
    source: string;
    problem: string;
    cause: string;
    suggestedFix: string;
    affectedPages?: string[];
  }>;
  summary: {
    totalIssues: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    aiAvailable: boolean;
  };
  scannedAt: string;
  progress?: {
    discoveredPages: number;
    completedPages: number;
    failedPages: number;
    issuesFound: number;
  };
}

export const DASHBOARD_BASE =
  (import.meta as unknown as { env: { DASHBOARD_BASE: string } }).env.DASHBOARD_BASE;

export const API_BASE = 'http://localhost:3100';
