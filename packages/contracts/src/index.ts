export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type ScanType = 'CURRENT_PAGE' | 'WEBSITE' | 'PROJECT';

export type ScanStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'COMPLETED_WITH_WARNINGS'
  | 'FAILED'
  | 'CANCELLED';

export type DiscoveryMethod = 'AUTOMATIC' | 'SITEMAP' | 'MANUAL';

export const MAX_WEBSITE_PAGES = 50;
export const DEFAULT_WEBSITE_MAX_PAGES = 20;

export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'ignored';

export type IssueCategory =
  | 'functional'
  | 'performance'
  | 'visualMobile'
  | 'accessibility'
  | 'bestPractices'
  | 'seo'
  | 'securityHygiene';

export type IssueSource =
  | 'playwright'
  | 'cdp'
  | 'lighthouse'
  | 'axe-core'
  | 'origami-rule'
  | 'vision-ai';

export interface IssueEvidence {
  selector?: string;
  url?: string;
  statusCode?: number;
  message?: string;
  snippet?: string;
  attribute?: string;
  value?: string;
  metric?: string;
  metricValue?: number | string;
  viewport?: { width: number; height: number };
  boundingBox?: { x: number; y: number; width: number; height: number };
  count?: number;
  items?: IssueEvidence[];
  [key: string]: unknown;
}

export interface Issue {
  id: string;
  category: IssueCategory;
  type: string;
  ruleId?: string;
  severity: Severity;
  title: string;
  evidence: IssueEvidence;
  confidence: number;
  impact: string;
  source: IssueSource;
  problem: string;
  cause: string;
  suggestedFix: string;
  groupKey?: string;
  /** Set when issue is persisted from a scan */
  scanId?: string;
  url?: string;
  status?: IssueStatus;
  createdAt?: string;
}

export interface CategoryScore {
  score: number;
  weight: number;
}

export interface HealthScore {
  overallScore: number;
  categories: {
    functional: CategoryScore;
    performance: CategoryScore;
    visualMobile: CategoryScore;
    accessibility: CategoryScore;
    bestPractices: CategoryScore;
    seo: CategoryScore;
    securityHygiene: CategoryScore;
  };
}

export interface PageMeta {
  url: string;
  title: string;
  description?: string;
  canonical?: string;
  robots?: string;
  viewport?: string;
  lang?: string;
}

export interface DomElement {
  selector: string;
  tag: string;
  text?: string;
  attributes: Record<string, string>;
  boundingBox?: { x: number; y: number; width: number; height: number };
  labelText?: string;
  hasAssociatedLabel?: boolean;
}

export interface ConsoleEntry {
  type: 'log' | 'warn' | 'error' | 'exception';
  message: string;
  timestamp: number;
  stack?: string;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  duration: number;
  resourceType: string;
  size?: number;
  failed?: boolean;
}

export interface PerformanceMetrics {
  navigationTiming?: Record<string, number>;
  lcp?: number;
  cls?: number;
  inp?: number;
  tbt?: number;
  fcp?: number;
  ttfb?: number;
}

export interface ScreenshotEvidence {
  viewport: 'desktop' | 'mobile';
  width: number;
  height: number;
  base64?: string;
  storageKey?: string;
}

export interface BrowserEvidence {
  page: PageMeta;
  documentDimensions: { width: number; height: number };
  viewport: { width: number; height: number };
  dom: {
    headings: DomElement[];
    images: DomElement[];
    links: DomElement[];
    buttons: DomElement[];
    forms: DomElement[];
    iframes: DomElement[];
  };
  layout: {
    horizontalOverflow: boolean;
    overflowWidth?: number;
    elementsOutsideViewport: DomElement[];
    fixedWidthElements: DomElement[];
  };
  console: ConsoleEntry[];
  network: NetworkEntry[];
  performance: PerformanceMetrics;
  screenshots: ScreenshotEvidence[];
  lighthouse?: Record<string, unknown>;
  axe?: Record<string, unknown>;
  collectedAt: string;
}

export interface PageScanOptions {
  includeScreenshots?: boolean;
  mobileViewport?: boolean;
  runLighthouse?: boolean;
  runAxe?: boolean;
}

export interface WebsiteScanOptions extends PageScanOptions {
  discoveryMethod: DiscoveryMethod;
  maxPages?: number;
  manualUrls?: string[];
}

export interface ScanRequest {
  url: string;
  scanType?: ScanType;
  pageEvidence?: Partial<BrowserEvidence>;
  options?: PageScanOptions;
  websiteOptions?: WebsiteScanOptions;
  ownerId?: string;
}

export interface CreateScanRequest extends ScanRequest {
  scanType: ScanType;
}

export interface ScanProgress {
  discoveredPages: number;
  completedPages: number;
  failedPages: number;
  issuesFound: number;
}

export interface PageScanRecord {
  pageScanId: string;
  url: string;
  status: ScanStatus;
  error?: string;
  healthScore?: HealthScore;
  issueCount?: number;
  scannedAt?: string;
}

export interface IssueOccurrence {
  pageScanId: string;
  url: string;
  evidence: IssueEvidence;
}

export interface AggregatedIssue extends Issue {
  occurrenceCount: number;
  affectedPages: string[];
  occurrences: IssueOccurrence[];
  isAggregated?: boolean;
}

export interface FailedPageRecord {
  url: string;
  pageScanId?: string;
  error: string;
}

export interface ScanSummary {
  totalIssues: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  aiAvailable: boolean;
}

export interface ScanArtifacts {
  screenshots: Array<{
    viewport: 'desktop' | 'mobile';
    storageKey: string;
    width: number;
    height: number;
  }>;
}

export interface AiScanSummary {
  summary: string;
  topIssues: string[];
  recommendations: string[];
}

export interface EvidenceSummary {
  consoleErrors: number;
  failedRequests: number;
  lighthousePerformanceScore?: number;
}

export interface ScanResponse {
  scanId: string;
  url: string;
  scanType?: ScanType;
  status?: ScanStatus;
  healthScore: HealthScore;
  issues: Issue[] | AggregatedIssue[];
  summary: ScanSummary;
  scannedAt: string;
  artifacts?: ScanArtifacts;
  aiSummary?: AiScanSummary;
  evidenceSummary?: EvidenceSummary;
  progress?: ScanProgress;
  pages?: PageScanRecord[];
  failedPages?: FailedPageRecord[];
  discoveryMethod?: DiscoveryMethod;
  ownerId?: string;
  error?: string;
}

export interface ScanStatusResponse {
  scanId: string;
  scanType: ScanType;
  status: ScanStatus;
  progress: ScanProgress;
  healthScore?: HealthScore;
  error?: string;
}

export interface ScanListItem {
  scanId: string;
  url: string;
  overallScore: number;
  totalIssues: number;
  scannedAt: string;
  scanType?: ScanType;
  status?: ScanStatus;
}

export interface IssueFilters {
  severity?: Severity | 'all';
  category?: IssueCategory | 'all';
  status?: IssueStatus | 'all';
  search?: string;
  sort?: 'severity' | 'category' | 'newest' | 'oldest';
}

export interface ExplainIssueRequest {
  issue: Issue;
  evidence?: Partial<BrowserEvidence>;
}

export interface AiExplanation {
  problem: string;
  cause: string;
  impact: string;
  suggestedFix: string;
  confidence: number;
}

export interface AskRequest {
  question: string;
  url?: string;
  issue?: Issue;
  evidence?: Partial<BrowserEvidence>;
}

export type AiTask =
  | 'summarize_scan'
  | 'explain_issue'
  | 'visual_qa'
  | 'fix_code'
  | 'ocr'
  | 'repository_search'
  | 'ask'
  | 'screenshot_to_code'
  | 'generate_component';

export interface AiGatewayRequest {
  task: AiTask;
  payload: Record<string, unknown>;
}

export interface AiGatewayResponse {
  success: boolean;
  task: AiTask;
  model?: string;
  result?: Record<string, unknown>;
  error?: string;
  /** Internal-only classification of `error` — see GenerationErrorCategory. */
  errorCategory?: GenerationErrorCategory;
}

export interface RuleDefinition {
  ruleId: string;
  category: IssueCategory;
  severity: Severity;
  confidence: number;
  impact: string;
  title: string;
  description: string;
  type: string;
  source: IssueSource;
  problem: string;
  cause: string;
  suggestedFix: string;
}

export interface RuleMatch {
  rule: RuleDefinition;
  evidence: IssueEvidence;
  groupKey?: string;
}

export const CATEGORY_WEIGHTS: Record<IssueCategory, number> = {
  functional: 25,
  performance: 20,
  visualMobile: 20,
  accessibility: 15,
  bestPractices: 10,
  seo: 5,
  securityHygiene: 5,
};

export const SEVERITY_DEDUCTIONS: Record<Severity, number> = {
  CRITICAL: 10,
  HIGH: 7,
  MEDIUM: 4,
  LOW: 2,
};

export const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

/** Map legacy IMPORTANT/MINOR values from older scans to the 4-tier model. */
export function normalizeLegacySeverity(value: string): Severity {
  const upper = value.toUpperCase();
  if (upper === 'CRITICAL') return 'CRITICAL';
  if (upper === 'HIGH') return 'HIGH';
  if (upper === 'MEDIUM') return 'MEDIUM';
  if (upper === 'LOW') return 'LOW';
  if (upper === 'IMPORTANT') return 'HIGH';
  if (upper === 'MINOR') return 'LOW';
  return 'MEDIUM';
}

/* ------------------------------------------------------------------------ */
/* Screenshot -> Code                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Generation targets. NOT a purely "framework" enum: TAILWIND is a styling
 * variant of the React output rather than a separate framework, and HTML_CSS
 * is framework-free. See CODE_TARGET_META for the explicit framework/styling
 * split so callers don't have to guess from the flat value.
 */
export type CodeTarget = 'REACT' | 'NEXT_JS' | 'TAILWIND' | 'HTML_CSS';

/** Future targets — not implemented yet, reserved so CodeTarget can grow without a contract rewrite. */
export type FutureCodeTarget = 'VUE' | 'SVELTE' | 'FLUTTER' | 'REACT_NATIVE';

export interface CodeTargetMeta {
  label: string;
  framework: 'react' | 'next' | 'html';
  styling: 'css-modules' | 'tailwind' | 'plain-css';
  primaryExtension: string;
}

export const CODE_TARGET_META: Record<CodeTarget, CodeTargetMeta> = {
  REACT: { label: 'React', framework: 'react', styling: 'css-modules', primaryExtension: '.jsx' },
  NEXT_JS: { label: 'Next.js', framework: 'next', styling: 'css-modules', primaryExtension: '.jsx' },
  TAILWIND: { label: 'React + Tailwind', framework: 'react', styling: 'tailwind', primaryExtension: '.jsx' },
  HTML_CSS: { label: 'HTML / CSS', framework: 'html', styling: 'plain-css', primaryExtension: '.html' },
};

export type ComponentGenerationStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'BLOCKED_PRIVACY'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT';

/**
 * Internal failure category — never shown verbatim to end users (the
 * existing `error` string stays the safe, generic user-facing message).
 * This is what lets logs/future-UI distinguish "AI infrastructure is
 * genuinely down" from "this one request hit a body-size limit, a timeout,
 * a cancellation, or an internal error" instead of collapsing all of those
 * into the same misleading signal.
 */
export type GenerationErrorCategory =
  | 'AI_UNAVAILABLE'
  | 'PAYLOAD_TOO_LARGE'
  | 'MODEL_TIMEOUT'
  | 'USER_CANCELLED'
  | 'CLIENT_DISCONNECTED'
  | 'MODEL_ERROR'
  | 'NETWORK_ERROR'
  | 'WORKER_ERROR'
  | 'QUEUE_ERROR';

export interface SelectionBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** window.devicePixelRatio at capture time — needed to align screenshot pixels with DOM CSS pixels. */
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface ComponentStyleSummary {
  display?: string;
  position?: string;
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  gap?: string;
  gridTemplateColumns?: string;
  width?: string;
  height?: string;
  padding?: string;
  margin?: string;
  color?: string;
  backgroundColor?: string;
  backgroundImage?: string;
  border?: string;
  borderRadius?: string;
  boxShadow?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  textAlign?: string;
  opacity?: string;
  overflow?: string;
  zIndex?: string;
}

export interface ComponentDomNode {
  tag: string;
  selector: string;
  id?: string;
  classList?: string[];
  attributes: Record<string, string>;
  text?: string;
  style: ComponentStyleSummary;
  boundingBox: { x: number; y: number; width: number; height: number };
  children: ComponentDomNode[];
}

export interface ComponentAssetRef {
  url: string;
  type: 'image' | 'svg' | 'background-image' | 'icon-font';
  width?: number;
  height?: number;
  alt?: string;
}

/**
 * Evidence bundle for a single Screenshot -> Code selection. Analogous to
 * BrowserEvidence for full-page scans, but scoped to one selected region.
 */
export interface ComponentEvidence {
  sourceUrl: string;
  pageTitle?: string;
  capturedAt: string;
  boundingBox: SelectionBoundingBox;
  /** JPEG, base64-encoded, cropped to boundingBox (plus a small context margin). */
  screenshotBase64: string;
  element: ComponentDomNode;
  ancestors: ComponentDomNode[];
  html: string;
  cssVariables: Record<string, string>;
  assets: ComponentAssetRef[];
  /** Set by the extension/content-script guard; re-verified server-side before any AI call. */
  containsSensitiveFields: boolean;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GeneratedComponentResult {
  target: CodeTarget;
  componentName: string;
  files: GeneratedFile[];
  dependencies: string[];
  notes: string[];
}

export interface ComponentVerification {
  passed: boolean;
  issues: string[];
}

export interface ComponentGenerationJob {
  jobId: string;
  ownerId?: string;
  sourceUrl: string;
  pageTitle?: string;
  target: CodeTarget;
  status: ComponentGenerationStatus;
  error?: string;
  /** Internal-only classification of `error` — see GenerationErrorCategory. Never the sole basis for a user-facing message. */
  errorCategory?: GenerationErrorCategory;
  result?: GeneratedComponentResult;
  verification?: ComponentVerification;
  aiAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateComponentJobRequest {
  target: CodeTarget;
  evidence: ComponentEvidence;
  ownerId?: string;
}

export interface ComponentJobListItem {
  jobId: string;
  sourceUrl: string;
  componentName?: string;
  target: CodeTarget;
  status: ComponentGenerationStatus;
  createdAt: string;
}
