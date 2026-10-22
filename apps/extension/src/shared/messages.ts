import type { PersistedActiveScan } from './scan-storage.js';
import type { PersistedResponsiveTest } from './responsive-test-storage.js';
import type { CodeTarget, ComponentEvidence, CreateBugReportResponse, ElementActionType, IssueCategory, ResponsiveTestResult, Severity } from '@origami/contracts';

export interface BugReportFormInput {
  title: string;
  description: string;
  severity: Severity;
  category: IssueCategory;
  reproductionSteps: string[];
  expectedBehavior?: string;
  actualBehavior?: string;
}

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
  | { type: 'CLEAR_COMPONENT_JOB' }
  | { type: 'RUN_ELEMENT_ACTION'; action: ElementActionType; evidence: ComponentEvidence; instruction?: string }
  | { type: 'RUN_RESPONSIVE_TEST'; url: string }
  | { type: 'GET_RESPONSIVE_TEST_STATE' }
  | { type: 'CANCEL_RESPONSIVE_TEST' }
  | { type: 'CLEAR_RESPONSIVE_TEST' }
  | { type: 'SELECT_ELEMENT_BY_SELECTOR'; tabId: number; selector: string; autoAction?: ElementActionType }
  | { type: 'CREATE_BUG_REPORT'; tabId: number; form: BugReportFormInput }
  | { type: 'COLLECT_BUG_REPORT_EVIDENCE' }
  | { type: 'GET_BUG_REPORT_CONTEXT' };

export interface CreateBugReportMessageResponse {
  ok: boolean;
  result?: CreateBugReportResponse;
  error?: string;
  errorCode?: string;
}

export interface ResponsiveTestMessageResponse {
  ok: boolean;
  result?: ResponsiveTestResult;
  error?: string;
  errorCode?: string;
}

export interface ResponsiveTestStateResponse {
  activeTest: PersistedResponsiveTest | null;
}

export interface ElementActionMessageResponse {
  ok: boolean;
  answer?: string;
  groundedInRepository?: boolean;
  error?: string;
}

export interface ScanStateResponse {
  activeScan: PersistedActiveScan | null;
}

export interface StartScanResponse {
  ok: boolean;
  scanId?: string;
  error?: string;
  /** See PersistedActiveScan.errorCode's doc comment — carried through the same message-passing round trip so the popup can show a reason-specific error instead of a generic one. */
  errorCode?: string;
}
