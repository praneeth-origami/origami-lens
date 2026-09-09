import type { PersistedActiveScan } from './scan-storage.js';
import type { CodeTarget, ComponentEvidence } from '@origami/contracts';

export interface WebsiteScanOptions {
  url: string;
  discoveryMethod: string;
  maxPages: number;
  manualUrls?: string[];
}

export type ExtensionMessage =
  | { type: 'GET_ACTIVE_TAB' }
  | { type: 'COLLECT_FROM_TAB'; tabId: number }
  | { type: 'START_WEBSITE_SCAN'; options: WebsiteScanOptions }
  | {
      type: 'START_CURRENT_PAGE_SCAN';
      targetUrl: string;
      pageEvidence: unknown;
    }
  | { type: 'GET_SCAN_STATE' }
  | { type: 'CLEAR_ACTIVE_SCAN' }
  | { type: 'START_ELEMENT_SELECTION'; tabId: number }
  | { type: 'CANCEL_ELEMENT_SELECTION'; tabId: number }
  | { type: 'CAPTURE_VISIBLE_TAB' }
  | { type: 'START_COMPONENT_GENERATION'; target: CodeTarget; evidence: ComponentEvidence }
  | { type: 'GET_COMPONENT_JOB_STATE' }
  | { type: 'CLEAR_COMPONENT_JOB' };

export interface ScanStateResponse {
  activeScan: PersistedActiveScan | null;
}

export interface StartScanResponse {
  ok: boolean;
  scanId?: string;
  error?: string;
}
