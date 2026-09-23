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
  /**
   * Which connected repository this finding's AI fix/PR should target
   * (migration 019) — unset until the user picks one (see
   * repository-finding-resolution-service.ts and IssueDetailPage.tsx's
   * repository picker); once set, the fix-proposal route rejects any later
   * attempt to target a different repository for this same finding
   * (REPOSITORY_MISMATCH). A scan finding has no inherent repository of its
   * own — this is always an explicit choice, never inferred/guessed.
   */
  repositoryId?: string;
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
  /** The organization that ran this scan (migration 018) — the real ownership boundary; resolved server-side from the authenticated caller, never client-supplied. Undefined for scans that predate this migration, which are therefore unowned and inaccessible. */
  organizationId?: string;
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
  /** Severity breakdown of `totalIssues` — same counts already computed once and stored in `ScanSummary`, just also projected onto the list item so the scans list can show them without a per-scan detail call. */
  critical?: number;
  high?: number;
  medium?: number;
  low?: number;
  scannedAt: string;
  scanType?: ScanType;
  status?: ScanStatus;
}

/* ------------------------------------------------------------------------ */
/* Lens Report — export/share (see apps/api/src/report-service.ts). A       */
/* versioned, stable representation derived from an already-persisted      */
/* ScanResponse — never recalculates the Health Score, never re-runs AI.    */
/* Decoupled from the DB row shape on purpose so future versions can evolve */
/* without breaking existing JSON/share consumers.                         */
/* ------------------------------------------------------------------------ */

export const REPORT_VERSION = '1.0' as const;

export interface LensReportIssue {
  id: string;
  title: string;
  severity: Severity;
  category: IssueCategory;
  status?: IssueStatus;
  problem: string;
  cause: string;
  impact: string;
  suggestedFix: string;
  url?: string;
  selector?: string;
  occurrenceCount?: number;
  affectedPages?: string[];
}

export interface LensReportSummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** Never CSV first (PDF is the primary human-facing report) — see ReportExportMenu.tsx's ordering. */
export type ReportExportFormat = 'pdf' | 'json' | 'markdown' | 'csv';

export interface LensReport {
  reportVersion: typeof REPORT_VERSION;
  generatedAt: string;
  scanId: string;
  url: string;
  /** The real scan state — never fabricated. A non-completed status means healthScore/categories are null (no partial/fake report). */
  reportStatus: ScanStatus;
  scannedAt?: string;
  healthScore: number | null;
  categories: Record<IssueCategory, number> | null;
  summary: LensReportSummary;
  issues: LensReportIssue[];
}

export interface ReportShareStatusResponse {
  active: boolean;
}

export interface CreateReportShareResponse {
  token: string;
  url: string;
}

export type ReportErrorCode = 'REPORT_NOT_READY' | 'REPORT_SHARE_NOT_FOUND' | 'INVALID_EXPORT_FORMAT';

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

/** Moved here from apps/web/src/api/client.ts (which re-exports it unchanged) so apps/api's report renderers (PDF/Markdown/CSV) use the exact same display labels as the web app, instead of a second hand-maintained copy. */
export const CATEGORY_LABEL: Record<IssueCategory, string> = {
  functional: 'Functional',
  performance: 'Performance',
  visualMobile: 'Visual / Mobile',
  accessibility: 'Accessibility',
  bestPractices: 'Best Practices',
  seo: 'SEO',
  securityHygiene: 'Security Hygiene',
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
  /** The organization that created this job (migration 018) — the real ownership boundary; resolved server-side from the authenticated caller, never client-supplied. Undefined for jobs that predate this migration, which are therefore unowned and inaccessible. */
  organizationId?: string;
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

/* ------------------------------------------------------------------------ */
/* Repository (Phase 1 — public repository connection + metadata only)      */
/*                                                                          */
/* No cloning, indexing, credentials, or AI analysis in this phase — see    */
/* the Repository Feature Audit. `repoUrl` is always the normalized,        */
/* credential-free, https://host/owner/repo form (never a raw user-supplied */
/* URL with a .git suffix, trailing slash, query string, or embedded auth). */
/* ------------------------------------------------------------------------ */

export type RepositoryProvider = 'GITHUB' | 'GITLAB' | 'BITBUCKET';

/**
 * CONNECTED is the only status Phase 1 ever creates; DISCONNECTED is reserved
 * for a future disconnect action. Phase 2 (clone + discovery) adds CLONING
 * (a clone job is in progress), READY_FOR_INDEXING (the most recent clone
 * completed successfully and Phase 3 can start from it), and FAILED (the
 * most recent clone OR index OR embedding job failed) — see
 * RepositoryCloneJob for the job-level lifecycle, which is distinct from this
 * repository-level state. Phase 3 (Tree-sitter/AST indexing) adds INDEXING
 * (an index job is in progress) and READY_FOR_SEARCH — despite the name,
 * this means only "a deterministic AST index exists," NOT "semantic search
 * is available"; Phase 4 (BGE-M3 embeddings) is deliberately layered on top
 * via two more values rather than overloading READY_FOR_SEARCH's meaning:
 * EMBEDDING (an embedding job is in progress) and EMBEDDINGS_READY (every
 * chunk for the current commit has a valid embedding — semantic search
 * itself is still Phase 5). Full lifecycle:
 *   READY_FOR_INDEXING -> INDEXING -> READY_FOR_SEARCH -> EMBEDDING -> EMBEDDINGS_READY
 * A job failure or cancellation at any stage reverts to the last good state
 * one step back (e.g. a failed embedding job reverts to READY_FOR_SEARCH,
 * not FAILED — the index is still good, only embedding needs a retry) rather
 * than the generic FAILED, which is reserved for a clone failure (there is
 * no earlier good state to revert to).
 */
export type RepositoryStatus =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'CLONING'
  | 'READY_FOR_INDEXING'
  | 'FAILED'
  | 'INDEXING'
  | 'READY_FOR_SEARCH'
  | 'EMBEDDING'
  | 'EMBEDDINGS_READY';

/**
 * Which layer of a project this repository represents (migration 019) —
 * lets a project connect either one FULL_STACK repository (today's only
 * shape, and the default for every existing/omitted-role repository) or two
 * separate FRONTEND/BACKEND repositories. Purely a label used for display
 * and for helping a human pick the right repository when a scan finding's
 * repository is ambiguous (see repository-finding-resolution-service.ts) —
 * never used to auto-guess a repository on its own.
 */
export type RepositoryRole = 'FRONTEND' | 'BACKEND' | 'FULL_STACK';

export interface Repository {
  id: string;
  /**
   * Legacy, pre-Phase-16 client-supplied identifier — kept only for
   * historical rows, never read for any authorization decision (see
   * migration 012). Real ownership is `organizationId` below.
   * @deprecated Use `organizationId`.
   */
  ownerId?: string;
  /** The user who created this repository connection (migration 012) — an audit/"created by" field only. Not read for authorization since Phase 2 (migration 016); see `organizationId`. */
  userId?: string;
  /** The organization that owns this repository (Phase 2, migration 016) — the only value any ownership/access check compares against. Every user has exactly one personal organization (auto-created at signup); a repository belongs to whichever organization created it, which is what makes Team/Agency sharing possible without ever changing this field's meaning. Undefined for legacy pre-Phase-2 rows, which are therefore unowned and inaccessible. */
  organizationId?: string;
  repoUrl: string;
  provider: RepositoryProvider;
  branch: string;
  status: RepositoryStatus;
  role: RepositoryRole;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRepositoryRequest {
  repoUrl: string;
  /** Optional — defaults to 'main' server-side if omitted. */
  branch?: string;
  /** Optional — defaults to 'FULL_STACK' server-side if omitted (migration 019). */
  role?: RepositoryRole;
  // No ownerId/userId field: ownership is always derived server-side from
  // the authenticated request.user.id (Phase 16/B) — a client can never
  // select who a repository belongs to.
}

/* ------------------------------------------------------------------------ */
/* Repository Clone + Discovery (Phase 2)                                   */
/*                                                                          */
/* Clone a connected repository into isolated storage, checkout the        */
/* requested branch, and deterministically inspect its structure. No       */
/* Tree-sitter/AST/indexing/embeddings/AI analysis and no execution of any  */
/* code contained in the repository — that starts in Phase 3, from         */
/* READY_FOR_INDEXING.                                                     */
/* ------------------------------------------------------------------------ */

export type RepositoryCloneStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

export interface RepositoryDiscoveryMetadata {
  fileCount: number;
  directoryCount: number;
  totalSizeBytes: number;
  topLevelDirectories: string[];
  topLevelFiles: string[];
  /** File extension (including the leading dot; empty string for extensionless files) -> count. */
  extensions: Record<string, number>;
  largestFiles: Array<{ path: string; sizeBytes: number }>;
}

export interface RepositoryCloneJob {
  jobId: string;
  repositoryId: string;
  ownerId?: string;
  status: RepositoryCloneStatus;
  commitSha?: string;
  discovery?: RepositoryDiscoveryMetadata;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloneRepositoryResponse {
  jobId: string;
  repositoryId: string;
  status: RepositoryCloneStatus;
}

/* ------------------------------------------------------------------------ */
/* Repository Indexing — Tree-sitter + AST + deterministic code chunking     */
/* (Phase 3)                                                                 */
/*                                                                          */
/* Deterministic indexing only — no embeddings, no pgvector, no AI calls,   */
/* and the indexer never executes any code contained in the repository.    */
/* Every chunk is associated with the exact commit it was produced from     */
/* (see RepositoryIndexJob.commitSha); the same repository + commit +       */
/* indexerVersion is expected to reproduce equivalent files/symbols/chunks. */
/* ------------------------------------------------------------------------ */

export type RepositoryIndexStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** Why a discovered file did or didn't end up contributing chunks. SKIPPED_IGNORED covers conventionally-noisy files (lockfiles, minified bundles) — directory-level ignoring (.git, node_modules, ...) happens before a file is ever considered at all and never appears here. */
export type RepositoryIndexedFileStatus =
  | 'INDEXED'
  | 'SKIPPED_BINARY'
  | 'SKIPPED_UNSUPPORTED_LANGUAGE'
  | 'SKIPPED_TOO_LARGE'
  | 'SKIPPED_IGNORED'
  | 'SKIPPED_SENSITIVE'
  | 'PARSE_ERROR';

export interface RepositoryIndexJob {
  jobId: string;
  repositoryId: string;
  cloneJobId: string;
  ownerId?: string;
  /** The exact clone commit this job indexed — see the module comment. */
  commitSha: string;
  status: RepositoryIndexStatus;
  /** Bumped only if the extraction/chunking algorithm itself changes in a way that would produce different output for the same input — see the Phase 3 report's determinism section. */
  indexerVersion: string;
  filesIndexed?: number;
  filesSkipped?: number;
  chunksCreated?: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryIndexedFile {
  id: string;
  indexJobId: string;
  repositoryId: string;
  commitSha: string;
  filePath: string;
  language: string;
  fileSizeBytes: number;
  /** sha256 of the file's decoded text content — absent for files whose content was never read (SKIPPED_SENSITIVE, SKIPPED_TOO_LARGE, SKIPPED_IGNORED). */
  contentHash?: string;
  status: RepositoryIndexedFileStatus;
  error?: string;
  createdAt: string;
}

export interface RepositoryCodeChunk {
  id: string;
  indexJobId: string;
  repositoryId: string;
  commitSha: string;
  fileId: string;
  filePath: string;
  language: string;
  symbol: string;
  symbolType: string;
  parentSymbol?: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** 0-based. */
  startColumn: number;
  endColumn: number;
  isExported: boolean;
  content: string;
  /** sha256 of `content` — see repository-chunker.ts's computeContentHash. */
  contentHash: string;
  /** Deterministic logical identity (repository + commit + file + symbol + range) — NOT this row's database id. See repository-chunker.ts's computeChunkKey. */
  chunkKey: string;
  createdAt: string;
}

export interface StartRepositoryIndexResponse {
  jobId: string;
  repositoryId: string;
  status: RepositoryIndexStatus;
}

export interface RepositoryIndexSummary {
  repositoryId: string;
  jobId: string;
  status: RepositoryIndexStatus;
  commitSha: string;
  filesIndexed: number;
  filesSkipped: number;
  chunksCreated: number;
  /** Indexed-file count per language, e.g. `{ typescript: 120, tsx: 80 }` — computed from actual indexed files, never estimated. */
  languages: Record<string, number>;
}

/* ------------------------------------------------------------------------ */
/* Repository Embeddings — BGE-M3 + pgvector (Phase 4)                       */
/*                                                                          */
/* Converts Phase 3's deterministic repository_code_chunks into semantic     */
/* vector embeddings via BGE-M3, stored in Postgres via pgvector. No         */
/* semantic search yet (Phase 5), no reranking, no AI repository analysis — */
/* this phase ends at reliable embedding storage. An embedding is valid     */
/* only for one exact (repository, commit, chunk content, model) tuple; see */
/* RepositoryCodeEmbedding's identity fields.                               */
/* ------------------------------------------------------------------------ */

export type RepositoryEmbeddingStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** Distinguishes *why* an embedding call failed — mirrors GenerationErrorCategory's role for component generation, but embeddings are a structurally different workload (batch vector calls, not chat completions) so this is its own type rather than reusing that one. */
export type EmbeddingErrorCategory =
  | 'EMBEDDING_PROVIDER_UNAVAILABLE'
  | 'EMBEDDING_TIMEOUT'
  | 'EMBEDDING_CANCELLED'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'EMBEDDING_INVALID_RESPONSE'
  | 'EMBEDDING_DATABASE_ERROR'
  | 'EMBEDDING_JOB_ERROR';

export interface RepositoryEmbeddingJob {
  jobId: string;
  repositoryId: string;
  indexJobId: string;
  ownerId?: string;
  commitSha: string;
  status: RepositoryEmbeddingStatus;
  /** The actual model that generated (or, on failure, was configured to generate) these embeddings — never assumed, always the provider's own reported/configured name. */
  model: string;
  /** The actual vector dimension returned by the provider, captured only once at least one embedding call has succeeded — never guessed ahead of time. */
  dimensions?: number;
  totalChunks?: number;
  embeddedChunks?: number;
  skippedChunks?: number;
  failedChunks?: number;
  error?: string;
  errorCategory?: EmbeddingErrorCategory;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmbedRepositoryResponse {
  jobId: string;
  repositoryId: string;
  status: RepositoryEmbeddingStatus;
}

export interface RepositoryEmbeddingSummary {
  repositoryId: string;
  jobId: string;
  status: RepositoryEmbeddingStatus;
  commitSha: string;
  model: string;
  dimensions?: number;
  totalChunks: number;
  embeddedChunks: number;
  skippedChunks: number;
  failedChunks: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

/* ------------------------------------------------------------------------ */
/* Repository Search — semantic retrieval + reranking (Phase 5)             */
/*                                                                          */
/* QUERY -> BGE-M3 query embedding -> pgvector candidate retrieval ->        */
/* bge-reranker-v2-m3 reranking -> ranked results. No AI explanation, no     */
/* repository chat, no code generation — this phase only locates relevant   */
/* chunks. Results are always scoped to one repository's most recently      */
/* completed embedding set (repository_id + commit_sha + model), never      */
/* mixed across commits, and never include vector arrays or sensitive-file  */
/* content (see the Phase 5 report's security section).                    */
/* ------------------------------------------------------------------------ */

export interface RepositorySearchRequest {
  query: string;
  /** Optional — bounded server-side by REPOSITORY_SEARCH_RESULT_LIMIT regardless of what's requested. */
  limit?: number;
}

export interface RepositorySearchResult {
  chunkId: string;
  filePath: string;
  language: string;
  symbol: string;
  symbolType: string;
  parentSymbol?: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  isExported: boolean;
  /** Raw pgvector cosine distance (`<=>`) — lower is more similar. Diagnostic metadata; final ordering uses rerankerScore when available, never this. */
  vectorDistance: number;
  /** Present only when reranking actually ran (see RepositorySearchResponse.reranked) — a cross-encoder relevance score, higher is more relevant. */
  rerankerScore?: number;
  /** Bounded preview only (see REPOSITORY_SEARCH_MAX_CONTENT_CHARS) — never a full file, never unbounded chunk content. */
  content?: string;
}

/** Distinguishes exactly why a search request could not be completed — mirrors EmbeddingErrorCategory's role for Phase 4, but scoped to the search pipeline's own failure modes. */
export type RepositorySearchErrorCode =
  | 'REPOSITORY_NOT_FOUND'
  | 'REPOSITORY_ACCESS_DENIED'
  | 'REPOSITORY_NOT_READY'
  | 'EMBEDDINGS_NOT_READY'
  | 'SEARCH_QUERY_INVALID'
  | 'EMBEDDING_PROVIDER_UNAVAILABLE'
  | 'EMBEDDING_TIMEOUT'
  | 'RERANKER_UNAVAILABLE'
  | 'RERANKER_TIMEOUT'
  | 'VECTOR_SEARCH_FAILED'
  | 'SEARCH_FAILED';

export interface RepositorySearchResponse {
  repositoryId: string;
  /** The exact indexed+embedded commit these results were retrieved from. */
  commitSha: string;
  query: string;
  results: RepositorySearchResult[];
  /** How many candidates pgvector returned before reranking (or before the vector-only fallback ordering, if degraded). */
  candidateCount: number;
  /** True only when bge-reranker-v2-m3 actually scored these results — false means results are ordered by raw vector distance only (degraded mode; see the Phase 5 report). Never mislabel vector-only ranking as reranked. */
  reranked: boolean;
}

/* ------------------------------------------------------------------------ */
/* Repository Issue Detection + AI Fix Proposal + Reviewable Diff (Phase 8)  */
/*                                                                          */
/* Issue -> analysis (using Phase 5's search/reranking as evidence          */
/* retrieval) -> AI fix proposal -> reviewable unified diff -> approve/     */
/* reject. Approval never touches the real repository, never creates a      */
/* branch/commit/PR — see the Phase 8 report. That belongs to a later      */
/* phase.                                                                    */
/* ------------------------------------------------------------------------ */

export type RepositoryIssueSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * OPEN -> ANALYZING -> ANALYZED -> FIX_PROPOSED -> APPROVED | REJECTED, with
 * FAILED reachable from ANALYZING (analysis failed) or FIX_PROPOSED's
 * generation step (proposal failed) — mirrors every other phase's job
 * failure convention of reverting to the previous good state rather than a
 * single shared FAILED with no history.
 */
export type RepositoryIssueStatus = 'OPEN' | 'ANALYZING' | 'ANALYZED' | 'FIX_PROPOSED' | 'APPROVED' | 'REJECTED' | 'FAILED';

export type RepositoryIssueSource = 'USER_REPORTED' | 'AI_DETECTED';

export interface RepositoryIssue {
  id: string;
  repositoryId: string;
  /** Best-effort, client-supplied identifier — same non-authentication caveat as Repository.ownerId. */
  ownerId?: string;
  /** The indexed commit this issue was filed against — set from the repository's current indexed commit at creation time, never client-supplied. */
  commitSha: string;
  title: string;
  description: string;
  severity: RepositoryIssueSeverity;
  status: RepositoryIssueStatus;
  source: RepositoryIssueSource;
  /** Repository-relative path — nullable for a repository-wide issue. */
  filePath?: string;
  symbol?: string;
  /** 1-based, inclusive. Both present or both absent. */
  lineStart?: number;
  lineEnd?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRepositoryIssueRequest {
  title: string;
  description: string;
  severity?: RepositoryIssueSeverity;
  filePath?: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
  // No ownerId: ownership is always derived server-side from the
  // authenticated request.user.id (Phase 16/B).
}

/** Distinguishes exactly why an issue/analysis/proposal request could not be completed — mirrors RepositorySearchErrorCode's role for Phase 5. */
export type RepositoryIssueErrorCode =
  | 'REPOSITORY_NOT_FOUND'
  | 'REPOSITORY_ACCESS_DENIED'
  | 'REPOSITORY_NOT_READY'
  | 'ISSUE_VALIDATION_FAILED'
  | 'FILE_NOT_FOUND'
  | 'SYMBOL_NOT_FOUND'
  | 'ISSUE_NOT_FOUND'
  | 'ANALYSIS_IN_PROGRESS'
  | 'ANALYSIS_NOT_FOUND'
  | 'ANALYSIS_PROVIDER_UNAVAILABLE'
  | 'ANALYSIS_TIMEOUT'
  | 'ANALYSIS_FAILED'
  | 'PROPOSAL_IN_PROGRESS'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_PROVIDER_UNAVAILABLE'
  | 'PROPOSAL_TIMEOUT'
  | 'PROPOSAL_INVALID'
  | 'PROPOSAL_ALREADY_DECIDED';

export type RepositoryIssueConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

export type RepositoryIssueAnalysisStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface RepositoryIssueAnalysis {
  id: string;
  issueId: string;
  repositoryId: string;
  commitSha: string;
  status: RepositoryIssueAnalysisStatus;
  summary?: string;
  rootCause?: string;
  /** LOW/MEDIUM/HIGH — the AI's own stated confidence, never fabricated by application code. Absent when analysis has not completed. */
  confidence?: RepositoryIssueConfidence;
  affectedFiles?: string[];
  affectedSymbols?: string[];
  /** The AI's evidence-grounded reasoning — must distinguish confirmed evidence from inference (see the Phase 8 report's AI contract section). */
  reasoning?: string;
  recommendedFix?: string;
  validationPlan?: string;
  /** The model that actually produced this analysis — never hard-coded, always the provider's own report. */
  model?: string;
  /** How many indexed code chunks were sent as evidence — bounded by REPOSITORY_ISSUE_MAX_EVIDENCE_CHUNKS. */
  evidenceChunkCount?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type RepositoryFixProposalStatus = 'QUEUED' | 'RUNNING' | 'FIX_PROPOSED' | 'APPROVED' | 'REJECTED' | 'FAILED';

export type RepositoryFixChangeType = 'MODIFIED' | 'ADDED' | 'DELETED';

export interface RepositoryFixFileChange {
  filePath: string;
  changeType: RepositoryFixChangeType;
  /** Computed server-side from the trusted indexed file record — never taken from the AI's own claim. Absent for ADDED files (no prior content to hash). */
  oldContentHash?: string;
  /** Phase 8 never applies a patch to compute this — the real file's post-image is never materialized. Reserved for a later phase that actually applies/validates a build. */
  newContentHash?: string;
  /** Unified-diff hunks for this one file only. */
  diff: string;
}

export interface RepositoryFixProposal {
  id: string;
  issueId: string;
  repositoryId: string;
  /** The repository's indexed commit this proposal targets — validated to still match the repository's current indexed commit at proposal time (see the Phase 8 report's validation section). */
  commitSha: string;
  status: RepositoryFixProposalStatus;
  summary?: string;
  filesChanged: RepositoryFixFileChange[];
  /** The complete multi-file unified diff, exactly as validated — this and filesChanged[].diff describe the same content at two granularities (whole-proposal vs. per-file). */
  proposedDiff: string;
  model?: string;
  /** Present only when status is FAILED — a safe, non-sensitive explanation of which validation rule rejected the proposal (see the Phase 8 report). Never echoes raw AI output verbatim. */
  validationError?: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------------ */
/* Repository AI Assistant — grounded code Q&A (Phase 9)                    */
/*                                                                          */
/* Reuses Phase 5's search + Phase 6's reranking pipeline unchanged as its  */
/* retrieval step; only adds a bounded context builder + a dedicated,      */
/* isolated LLM task on top. Read-only: never modifies the repository —    */
/* see the Phase 9 report.                                                 */
/* ------------------------------------------------------------------------ */

export interface RepositoryAskRequest {
  query: string;
}

/**
 * Always derived from real Phase 3 chunk metadata that was actually
 * included in the LLM's context — never fabricated or approximated line
 * numbers, and never every retrieved chunk if the context budget dropped
 * some of the lower-ranked ones (see the Phase 9 report's context-builder
 * section).
 */
export interface RepositoryAskSource {
  filePath: string;
  symbol: string;
  symbolType: string;
  /** 1-based, inclusive — taken verbatim from the indexed chunk, never recalculated. */
  startLine: number;
  endLine: number;
}

/** Distinguishes exactly why a repository Q&A request could not be completed — mirrors RepositorySearchErrorCode's role for Phase 5/RepositoryIssueErrorCode's for Phase 8. */
export type RepositoryAskErrorCode =
  | 'REPOSITORY_NOT_FOUND'
  | 'REPOSITORY_ACCESS_DENIED'
  | 'REPOSITORY_NOT_READY'
  | 'EMBEDDINGS_NOT_READY'
  | 'ASK_QUERY_INVALID'
  | 'EMBEDDING_PROVIDER_UNAVAILABLE'
  | 'EMBEDDING_TIMEOUT'
  | 'VECTOR_SEARCH_FAILED'
  | 'LLM_PROVIDER_UNAVAILABLE'
  | 'LLM_TIMEOUT'
  | 'ASK_FAILED';

export interface RepositoryAskResponse {
  repositoryId: string;
  /** The exact indexed+embedded commit the retrieved evidence came from — same field as RepositorySearchResponse.commitSha. */
  commitSha: string;
  query: string;
  /** Grounded in — and only in — the sources below. Never invents files/symbols; explicitly says so when the retrieved evidence is insufficient (see the Phase 9 report). */
  answer: string;
  sources: RepositoryAskSource[];
  /** How many candidates pgvector returned before reranking — same meaning as RepositorySearchResponse.candidateCount. */
  candidateCount: number;
  /** How many of those candidates were actually retained as context/sources after reranking and the context-size budget. */
  resultCount: number;
  /** True only when bge-reranker-v2-m3 actually scored these results — false means degraded vector-only ranking was used (see the Phase 6/9 reports). Never mislabeled. */
  reranked: boolean;
  /** The text-generation model that actually produced the answer — never hard-coded, always the provider's own report. */
  model?: string;
}

/* ------------------------------------------------------------------------ */
/* AI Issue Analysis + Code Fix Proposal for scan findings (Phase 10)       */
/*                                                                          */
/* Takes an EXISTING, persisted website-scan Issue (never a client-         */
/* supplied fake finding) and proposes a reviewable code change against a   */
/* connected, indexed repository — reusing Phase 5/6/9's search/reranking/  */
/* context pipeline unchanged. REVIEW-ONLY: nothing here ever writes to the */
/* repository, creates a branch, commits, or pushes — see the Phase 10      */
/* report. Deliberately distinct from Phase 8's repository-issue fix        */
/* proposals (RepositoryFixProposal above): the *source* here is a website-  */
/* scan finding (packages/contracts' `Issue`), not a user-reported          */
/* repository issue, and the change representation is structured hunks      */
/* (oldText/newText/line range) rather than unified-diff text.              */
/* ------------------------------------------------------------------------ */

export interface RepositoryFixProposalRequest {
  /** Optional, bounded user guidance (e.g. "Fix only the accessibility issue, don't change layout") — always passed to the AI as USER input, never capable of overriding its system instructions (see the Phase 10 report's prompt-injection section). */
  instruction?: string;
}

export interface RepositoryFixProposalHunk {
  /** 1-based, inclusive — taken from the indexed chunk's real line metadata, never invented. */
  startLine: number;
  endLine: number;
  /** Must appear verbatim in the real indexed content for this file — validated server-side, never trusted from the AI alone (see the Phase 10 report's proposal-validation section). */
  oldText: string;
  newText: string;
}

export interface RepositoryFixProposalFileChange {
  filePath: string;
  language: string;
  hunks: RepositoryFixProposalHunk[];
}

/** Real Phase 3 chunk metadata for one piece of retrieved evidence the proposal was actually grounded in — same shape/spirit as RepositoryAskSource. */
export interface RepositoryFixProposalSource {
  filePath: string;
  symbol: string;
  symbolType: string;
  startLine: number;
  endLine: number;
}

/** PROPOSED: a validated, reviewable change was produced. INSUFFICIENT_EVIDENCE: the retrieved repository context did not support a safe, grounded fix — no file/symbol/change was fabricated (see the Phase 10 report's insufficient-evidence section). Never a third silent state. */
export type RepositoryFindingFixStatus = 'PROPOSED' | 'INSUFFICIENT_EVIDENCE';

/** Distinguishes exactly why a finding-fix request could not be completed — mirrors RepositoryAskErrorCode's role for Phase 9. */
export type RepositoryFixProposalErrorCode =
  | 'REPOSITORY_NOT_FOUND'
  | 'REPOSITORY_ACCESS_DENIED'
  | 'REPOSITORY_NOT_READY'
  | 'EMBEDDINGS_NOT_READY'
  | 'FINDING_NOT_FOUND'
  | 'FINDING_INVALID'
  | 'EMBEDDING_PROVIDER_UNAVAILABLE'
  | 'EMBEDDING_TIMEOUT'
  | 'VECTOR_SEARCH_FAILED'
  | 'LLM_PROVIDER_UNAVAILABLE'
  | 'LLM_TIMEOUT'
  /** The LLM was reachable and responded, but the response body was not valid/complete JSON (e.g. truncated mid-string by an output-token limit) — distinct from LLM_PROVIDER_UNAVAILABLE, which means the provider could not be reached at all. */
  | 'LLM_INVALID_RESPONSE'
  | 'PROPOSAL_INVALID'
  | 'FIX_PROPOSAL_FAILED'
  /** This finding already has a different repository recorded against it (see Issue.repositoryId) — a fix was already generated once against that repository, and this request targets a different one. Never silently redirected. */
  | 'REPOSITORY_MISMATCH';

/**
 * The result of `resolveRepositoryForIssue` (see
 * repository-finding-resolution-service.ts) — 'resolved' when there is
 * exactly one sensible repository (already chosen for this finding, or the
 * only one connected); 'unresolved' when more than one repository could
 * apply and nothing has been chosen yet (the caller must ask the user,
 * never guess); 'none' when no repository is connected at all.
 */
export type RepositoryResolution =
  | { status: 'resolved'; repository: Repository }
  | { status: 'unresolved'; candidates: Repository[] }
  | { status: 'none' };

export interface RepositoryFixProposalResponse {
  repositoryId: string;
  findingId: string;
  /** The exact indexed+embedded commit the retrieved evidence came from. */
  commitSha: string;
  status: RepositoryFindingFixStatus;
  summary: string;
  /** Explains what the evidence confirms vs. what was inferred — never claims a fix is safe when the evidence doesn't support it (see the Phase 10 report's AI-contract section). */
  reasoning: string;
  /** Empty when status is INSUFFICIENT_EVIDENCE. */
  changes: RepositoryFixProposalFileChange[];
  sources: RepositoryFixProposalSource[];
  candidateCount: number;
  reranked: boolean;
  model?: string;
}

/* ------------------------------------------------------------------------ */
/* Repository Fix Application (Phase 11)                                    */
/*                                                                          */
/* Takes an already-produced Phase 10 finding-fix proposal (the client      */
/* resubmits it — Phase 10 never persists proposals) and safely applies it  */
/* to an ISOLATED copy of the repository, never the original connected      */
/* clone: locate each hunk's oldText by real file content (never trusting   */
/* the AI's reported line numbers), apply it, run Tree-sitter syntax        */
/* validation on every changed supported-language file, and produce a real  */
/* `git diff` for review. Still REVIEW-ONLY: this never commits, pushes,    */
/* creates a branch, or opens a Pull Request — status is always             */
/* READY_FOR_REVIEW, never COMMITTED/PUSHED (see the Phase 11 report).      */
/* Structural/path/sensitive-file/syntax validity is deterministically      */
/* checked; semantic correctness of the fix itself is NOT — see the         */
/* reasoning field Phase 10 already returns for that.                       */
/* ------------------------------------------------------------------------ */

export interface RepositoryFixApplyRequest {
  /** The full Phase 10 RepositoryFixProposalResponse to apply — re-validated server-side line by line, never trusted as-is (see the Phase 11 report's re-validation section). */
  proposal: RepositoryFixProposalResponse;
}

/** VALID/INVALID only apply to a Tree-sitter-parseable language; UNSUPPORTED (e.g. html) means no AST check was possible — never claimed as validated. */
export type RepositoryFixSyntaxStatus = 'VALID' | 'INVALID' | 'UNSUPPORTED';

export interface RepositoryFixChangedFile {
  filePath: string;
  additions: number;
  deletions: number;
  syntaxStatus: RepositoryFixSyntaxStatus;
}

/**
 * Compares what the AI reported vs. where the change was actually located
 * and applied, by real file content — the fix for the Phase 10-discovered
 * line-number grounding gap. `matchedExactly: false` does not mean the
 * patch failed; oldText-based content matching is authoritative and the
 * patch is still applied, this field only surfaces the discrepancy for the
 * reviewing UI.
 */
export interface RepositoryFixLineGrounding {
  filePath: string;
  reportedStartLine: number;
  reportedEndLine: number;
  actualStartLine: number;
  actualEndLine: number;
  matchedExactly: boolean;
}

export type RepositoryFixApplyErrorCode =
  | 'REPOSITORY_NOT_FOUND'
  | 'REPOSITORY_ACCESS_DENIED'
  | 'FINDING_NOT_FOUND'
  | 'REPOSITORY_NOT_READY'
  | 'STALE_REPOSITORY'
  | 'PROPOSAL_INVALID'
  | 'UNSAFE_PATH'
  | 'SENSITIVE_FILE'
  | 'FILE_NOT_FOUND'
  | 'OLD_TEXT_NOT_FOUND'
  | 'OLD_TEXT_AMBIGUOUS'
  | 'SYNTAX_VALIDATION_FAILED'
  | 'SYNTAX_VALIDATION_UNSUPPORTED'
  | 'WORKSPACE_CREATION_FAILED'
  | 'GIT_DIFF_FAILED'
  | 'CANCELLED'
  | 'FIX_APPLICATION_FAILED';

export type RepositoryFixApplyStatus = 'READY_FOR_REVIEW';

export interface RepositoryFixApplyResponse {
  status: RepositoryFixApplyStatus;
  repositoryId: string;
  findingId: string;
  /** The commit the isolated workspace was created from — verified to match the repository clone's current HEAD before anything was applied (see STALE_REPOSITORY). */
  baseCommitSha: string;
  changedFiles: RepositoryFixChangedFile[];
  /** A REAL unified diff generated by `git diff` inside the isolated workspace — never fabricated from oldText/newText. */
  diff: string;
  /** Only ever all-"VALID" (syntax may be UNSUPPORTED) — any failing check aborts the whole operation with a typed error instead of returning a partially-successful response (see the Phase 11 report's transactional-application section). */
  validation: {
    proposal: 'VALID';
    pathSafety: 'VALID';
    grounding: 'VALID';
    syntax: RepositoryFixSyntaxStatus;
  };
  lineGrounding: RepositoryFixLineGrounding[];
}

/* ------------------------------------------------------------------------ */
/* Repository Fix Git Workflow (Phase 12)                                   */
/*                                                                          */
/* Extends Phase 11's review-only diff into an OPTIONAL, explicitly-        */
/* user-approved Git workflow: branch -> commit -> push -> Pull Request.    */
/* Two-step, matching the spec's "review" + "execute" alternative:          */
/*   POST /repositories/:id/findings/:findingId/fix-proposal/review   ->    */
/*     re-runs Phase 11's exact apply pipeline but RETAINS the isolated     */
/*     workspace and returns an `applicationId` referencing it.             */
/*   POST /repositories/:id/findings/:findingId/fix-proposal/approve  ->    */
/*     the ONLY endpoint that ever creates a branch, commits, pushes, or    */
/*     opens a PR — requires the applicationId from the review step and    */
/*     re-validates everything before doing so. Never automatic: generating */
/*     or even applying a proposal (Phase 10/11) never triggers any of      */
/*     this on its own.                                                     */
/* ------------------------------------------------------------------------ */

export interface RepositoryFixReviewRequest {
  /** The full Phase 10 RepositoryFixProposalResponse to review — identical contract to Phase 11's apply request. */
  proposal: RepositoryFixProposalResponse;
}

/** Same shape as RepositoryFixApplyResponse plus the applicationId a subsequent /approve call must reference — the isolated workspace behind this applicationId is retained (not discarded) specifically so it can be reused, so this endpoint is NOT interchangeable with Phase 11's stateless /fix-proposal/apply. */
export interface RepositoryFixReviewResponse {
  applicationId: string;
  status: RepositoryFixApplyStatus;
  repositoryId: string;
  findingId: string;
  commitSha: string;
  changedFiles: RepositoryFixChangedFile[];
  diff: string;
  lineGrounding: RepositoryFixLineGrounding[];
  syntaxStatus: RepositoryFixSyntaxStatus;
  /** Always true when status is READY_FOR_REVIEW — present as an explicit, self-describing field the frontend can key its "Create Pull Request" action off of, rather than re-deriving it from status. */
  readyForApproval: boolean;
  /** ISO timestamp — the review/retained workspace is discarded after this if never approved (see REPOSITORY_FIX_WORKSPACE_TTL_MS). */
  expiresAt: string;
}

export interface RepositoryFixApproveRequest {
  applicationId: string;
  /** The SAME proposal object the review step was given — re-validated (including a content hash comparison against what was actually reviewed) before anything is written, so a client cannot swap in a different change set between review and approval. */
  proposal: RepositoryFixProposalResponse;
}

export type RepositoryFixWorkflowStatus =
  | 'REVIEWABLE'
  | 'APPROVED'
  | 'BRANCH_CREATED'
  | 'COMMITTED'
  | 'PUSHED'
  | 'PR_OPENED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export type RepositoryFixPrProvider = 'GITHUB' | 'GITLAB' | 'BITBUCKET';

export interface RepositoryFixApproveResponse {
  applicationId: string;
  repositoryId: string;
  findingId: string;
  status: RepositoryFixWorkflowStatus;
  branchName: string;
  /** The NEW commit created on the fix branch — distinct from baseCommitSha/commitSha (the original, unmodified commit the fix was based on). */
  commitSha: string;
  baseCommitSha: string;
  provider: RepositoryFixPrProvider;
  prNumber?: number;
  prUrl?: string;
}

export type RepositoryFixWorkflowErrorCode =
  | 'REPOSITORY_NOT_FOUND'
  | 'REPOSITORY_ACCESS_DENIED'
  | 'REPOSITORY_NOT_READY'
  | 'FINDING_NOT_FOUND'
  | 'STALE_REPOSITORY'
  | 'PROPOSAL_INVALID'
  | 'UNSAFE_PATH'
  | 'SENSITIVE_FILE'
  | 'FILE_NOT_FOUND'
  | 'OLD_TEXT_NOT_FOUND'
  | 'OLD_TEXT_AMBIGUOUS'
  | 'SYNTAX_VALIDATION_FAILED'
  | 'SYNTAX_VALIDATION_UNSUPPORTED'
  | 'WORKSPACE_CREATION_FAILED'
  | 'GIT_DIFF_FAILED'
  | 'CANCELLED'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_EXPIRED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_EXPIRED'
  | 'COMMIT_SHA_MISMATCH'
  | 'UNEXPECTED_CHANGES'
  | 'GIT_AUTH_NOT_CONFIGURED'
  | 'GIT_REMOTE_UNAVAILABLE'
  | 'GIT_BRANCH_INVALID'
  | 'GIT_BRANCH_EXISTS'
  | 'GIT_COMMIT_IDENTITY_MISSING'
  | 'GIT_COMMIT_FAILED'
  | 'GIT_PUSH_FAILED'
  | 'GIT_DIRTY_WORKTREE'
  | 'PROVIDER_UNSUPPORTED'
  | 'PR_CREATION_FAILED'
  | 'PR_ALREADY_EXISTS'
  | 'WORKFLOW_IN_PROGRESS'
  | 'FIX_APPLICATION_FAILED'
  | 'FIX_WORKFLOW_FAILED';

/* ------------------------------------------------------------------------ */
/* Phase 16/A — Real application user identity + sessions (migration 011).  */
/* Deliberately minimal: no roles, no teams, no provider-authorization       */
/* fields here — this is only "who is signed in," never "what Git repos can */
/* they touch" (that's provider_connections, a later phase). `id` is the    */
/* only thing ever sent to the frontend; no session id, no provider token.  */
/* ------------------------------------------------------------------------ */

/**
 * The set of providers Origami Lens can authenticate a HUMAN with — a
 * distinct concept from RepositoryProvider (which git host a REPOSITORY is
 * hosted on). The two happened to be the same three values while GitHub was
 * the only login provider, but GOOGLE is login-only: it can never host a
 * repository, so it must never appear anywhere RepositoryProvider is used
 * (provider_connections, repositories.provider, the git-provider-client
 * switch statements, etc.) — only here, for `users.primary_provider`. Same
 * reasoning applies to 'EMAIL' (migration 020): a password-authenticated
 * account can never host a repository either.
 */
export type AuthProvider = RepositoryProvider | 'GOOGLE' | 'EMAIL';

/**
 * Phase 3 — who the user says they are, captured once during onboarding
 * (migration 017). Purely descriptive: nothing in the app branches on this
 * yet (that's Phase 4, persona-specific features) — it exists so that work
 * has real data to build on instead of guessing.
 */
export type Persona = 'DEVELOPER' | 'FOUNDER' | 'AGENCY' | 'DESIGNER' | 'QA_TEAM' | 'PRODUCT_MANAGER';

/**
 * Phase 18 — platform-level authorization (migration 026), completely
 * separate from Persona above despite the shared 'FOUNDER' string: Persona
 * is a nullable, purely descriptive onboarding self-report that nothing
 * branches on; PlatformRole is a real, non-nullable authorization boundary
 * (see authorization/platform-permissions.ts). Never confuse
 * user.persona === 'FOUNDER' with user.platformRole === 'FOUNDER' — they
 * are unrelated columns/enums that happen to share a word.
 */
export type PlatformRole = 'FOUNDER' | 'ADMIN' | 'USER';

export interface AuthUser {
  id: string;
  primaryProvider: AuthProvider;
  /** Display-only (e.g. GitHub login, or Google display name) — never used as an authorization key. */
  primaryProviderLogin: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  /** Undefined until the user completes the Phase 3 onboarding question — the frontend uses this to show the onboarding prompt exactly once. */
  persona?: Persona;
  /** Defaults to 'USER' for every account — see PlatformRole's doc comment for why this is a different concept from `persona` above. */
  platformRole: PlatformRole;
  /** Phase 18 — GET /admin/users' "created date" column. Not previously exposed on AuthUser; added for the admin user list rather than fabricated there. */
  createdAt: string;
  /** Phase 20 — which workspace is "active" once a user belongs to more than one (e.g. after accepting a workspace invitation). Undefined for every user who has only ever belonged to their personal organization. */
  activeOrganizationId?: string;
  /** Set once the user confirms an email-verification link (password accounts only — OAuth accounts never set this, since the provider already verified the email). Undefined means "not verified" or "not applicable"; nothing in the app currently gates on this — see VerifyEmailRequest's doc comment. */
  emailVerifiedAt?: string;
}

export interface SetPersonaRequest {
  persona: Persona;
}

export interface AuthMeResponse {
  user: AuthUser | null;
}

export type AuthErrorCode =
  | 'AUTH_NOT_CONFIGURED'
  | 'OAUTH_STATE_MISMATCH'
  | 'OAUTH_EXCHANGE_FAILED'
  | 'UNAUTHENTICATED'
  /** Deliberately the SAME code/message for "no account with this email" and "wrong password" — never reveals which one, to avoid leaking which emails have an Origami Lens account. */
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'WEAK_PASSWORD'
  | 'RESET_TOKEN_INVALID'
  /** The backend has no SMTP configured — forgot-password still returns a generic success response to the caller either way (see password-auth-service.ts), this code is only ever logged server-side, never sent to the client. */
  | 'EMAIL_NOT_CONFIGURED'
  | 'VERIFICATION_TOKEN_INVALID';

/* ------------------------------------------------------------------------ */
/* Phase 16/H — Email + password login (migration 020/021), a third        */
/* application-identity provider alongside GitHub/Google above. Results in */
/* the exact same AuthUser/session/cookie model — see auth-service.ts's    */
/* loginWithGitHub/loginWithGoogle and password-auth-service.ts's mirror   */
/* of that same shape.                                                     */
/* ------------------------------------------------------------------------ */

export interface RegisterRequest {
  displayName: string;
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

/** Always returns { ok: true } regardless of whether the email exists — see password-auth-service.ts's requestPasswordReset. */
export interface ForgotPasswordResponse {
  ok: true;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
}

/**
 * Email verification — additive only (see password-auth-service.ts's
 * registerWithEmail/confirmEmailVerification/resendVerificationEmail):
 * sends a confirm link on password registration and lets it be confirmed
 * or resent. Nothing in the app gates on `AuthUser.emailVerifiedAt` today —
 * this is purely an available, self-serve confirmation, not an access
 * control mechanism.
 */
export interface VerifyEmailRequest {
  token: string;
}

/** Always returns { ok: true } regardless of whether the email exists or is already verified — same non-enumeration shape as ForgotPasswordResponse. */
export interface ResendVerificationEmailResponse {
  ok: true;
}

export interface ResendVerificationEmailRequest {
  email: string;
}

/* ------------------------------------------------------------------------ */
/* Phase 2 — Organizations. Every user gets exactly one personal            */
/* organization, auto-created at signup (migration 015) — the real         */
/* ownership boundary for repositories (see Repository.organizationId) and */
/* the foundation for Team/Agency sharing: a non-personal organization with */
/* more than one MEMBER/OWNER is the same shape, just without a            */
/* personalOwnerUserId. Nothing in this phase exposes multi-member         */
/* organizations yet.                                                      */
/* ------------------------------------------------------------------------ */

/** Expanded in migration 027 (Phase 18) from just OWNER/MEMBER — see authorization/workspace-permissions.ts, the one place these are turned into actual permission decisions. */
export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | 'CLIENT_VIEWER';

export interface Organization {
  id: string;
  name: string;
  /** Set only for a user's own personal organization (one per user, guaranteed unique). Undefined for a real team/agency organization. */
  personalOwnerUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMembership {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  createdAt: string;
}

/** OrganizationMembership joined with the member's own user record — the shape the workspace-members UI actually needs (an id/role pair alone isn't enough to render a member list). */
export interface WorkspaceMember {
  userId: string;
  email?: string;
  displayName?: string;
  role: OrganizationRole;
  joinedAt: string;
}

export interface ListWorkspaceMembersResponse {
  members: WorkspaceMember[];
}

export interface AddWorkspaceMemberRequest {
  email: string;
  role: OrganizationRole;
}

export interface UpdateWorkspaceMemberRoleRequest {
  role: OrganizationRole;
}

export interface TransferWorkspaceOwnershipRequest {
  newOwnerUserId: string;
}

/** GET /workspace/role — the one lightweight lookup the frontend uses to hide/disable actions a user can't perform; the API remains authoritative regardless of what the UI does with this. */
export interface WorkspaceRoleResponse {
  organizationId: string;
  role: OrganizationRole;
}

export type WorkspaceErrorCode =
  | 'FORBIDDEN'
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_ALREADY_EXISTS'
  | 'CANNOT_REMOVE_LAST_OWNER'
  | 'MULTI_MEMBER_NOT_SUPPORTED_ON_PLAN';

/* ------------------------------------------------------------------------ */
/* Phase 20 — workspace email invitations (migration 030). Membership is    */
/* created only on explicit acceptance; see workspace-invitation-service.ts.*/
/* ------------------------------------------------------------------------ */

export type WorkspaceInvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';

export interface WorkspaceInvitation {
  id: string;
  organizationId: string;
  invitedEmail: string;
  invitedByUserId: string;
  invitedByEmail?: string;
  role: OrganizationRole;
  status: WorkspaceInvitationStatus;
  expiresAt: string;
  acceptedAt?: string;
  createdAt: string;
}

export interface CreateWorkspaceInvitationRequest {
  email: string;
  role: OrganizationRole;
}

export interface CreateWorkspaceInvitationResponse {
  invitation: WorkspaceInvitation;
  /** Whether the invitation email actually left the server — a delivery failure never blocks the invitation from being created (see spec §30); the UI surfaces this so an OWNER/ADMIN knows to use Resend. */
  emailDelivered: boolean;
}

export interface ListWorkspaceInvitationsResponse {
  invitations: WorkspaceInvitation[];
}

/** GET /invitations/:token — public, no auth required. Only what the link's possessor should already know; never the token itself. */
export interface InvitationPreviewResponse {
  status: WorkspaceInvitationStatus | 'NOT_FOUND';
  organizationName?: string;
  inviterEmail?: string;
  invitedEmail?: string;
  role?: OrganizationRole;
  expiresAt?: string;
}

export interface AcceptInvitationResponse {
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
}

export type WorkspaceInvitationErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_ROLE'
  | 'INVALID_EMAIL'
  | 'MEMBER_ALREADY_EXISTS'
  | 'MULTI_MEMBER_NOT_SUPPORTED_ON_PLAN'
  | 'INVITATION_NOT_FOUND'
  | 'INVITATION_EXPIRED'
  | 'INVITATION_REVOKED'
  | 'INVITATION_ALREADY_ACCEPTED'
  | 'EMAIL_MISMATCH';

/** GET /workspace/list-mine — every organization the caller belongs to, for the workspace switcher (only rendered when this has more than one entry). */
export interface WorkspaceListItem {
  organizationId: string;
  name: string;
  role: OrganizationRole;
}

export interface ListMyWorkspacesResponse {
  workspaces: WorkspaceListItem[];
}

export interface SwitchWorkspaceRequest {
  organizationId: string;
}

/* ------------------------------------------------------------------------ */
/* Phase 18 — platform administration (migration 026/028). FOUNDER/ADMIN    */
/* only; see authorization/platform-permissions.ts.                        */
/* ------------------------------------------------------------------------ */

export interface AdminUserSummary {
  id: string;
  email?: string;
  displayName?: string;
  platformRole: PlatformRole;
  createdAt: string;
  workspaceCount: number;
  /** The user's PERSONAL organization's plan (plans belong to organizations, not users — see PLAN_DEFINITIONS) — undefined only when searchUsersForAdmin's plan lookup wasn't run (e.g. listUsersForAdmin's plain listing). */
  plan?: SubscriptionPlan;
}

export interface AdminListUsersResponse {
  users: AdminUserSummary[];
}

export interface AdminWorkspaceSummary {
  id: string;
  name: string;
  plan: SubscriptionPlan;
  memberCount: number;
  ownerEmail?: string;
  createdAt: string;
}

export interface AdminListWorkspacesResponse {
  workspaces: AdminWorkspaceSummary[];
}

export interface UpdatePlatformRoleRequest {
  platformRole: PlatformRole;
}

export type AdminErrorCode = 'FORBIDDEN' | 'USER_NOT_FOUND' | 'CANNOT_DEMOTE_LAST_FOUNDER';

/* ------------------------------------------------------------------------ */
/* Phase 19 — the admin operational activity dashboard. Reuses every job    */
/* table's own status enum (scans/component_jobs/repository_*_jobs/         */
/* repository_fix_workflows) rather than inventing a parallel one — see     */
/* apps/api/src/admin/activity-repository.ts, the single place these get    */
/* turned into cross-organization aggregate/list queries.                  */
/* ------------------------------------------------------------------------ */

export type AdminActivityType = 'SCAN' | 'AI_JOB' | 'REPOSITORY_JOB' | 'FIX_WORKFLOW';

export interface AdminActivityItem {
  id: string;
  type: AdminActivityType;
  /** A short human label of what's happening, e.g. "Website scan", "Screenshot → Code", "Repository clone" — never raw evidence/prompts/diffs. */
  label: string;
  status: string;
  organizationId?: string;
  /** Hostname or repository/finding display name — never a full URL with query strings, never file contents or evidence. */
  targetLabel?: string;
  startedAt: string;
  updatedAt: string;
}

export interface ListAdminActivityResponse {
  items: AdminActivityItem[];
}

export interface AdminActiveNowCounts {
  activeUsers: number;
  activeScans: number;
  activeAiJobs: number;
  activeRepositoryJobs: number;
  activeFixWorkflows: number;
}

export interface AdminSubscriptionBreakdown {
  byPlan: Record<SubscriptionPlan, number>;
  byStatus: Record<SubscriptionStatus, number>;
}

export interface AdminUsageTodayByPlan {
  plan: SubscriptionPlan;
  inspections: number;
  aiQuestions: number;
  screenshotToCode: number;
}

export interface AdminOverviewSystemHealth {
  postgres: 'ok' | 'down';
  redis: 'ok' | 'down' | 'not_configured';
  api: 'ok' | 'down';
  browserWorker: 'ok' | 'down';
  aiRouter: 'ok' | 'down';
}

export interface AdminOverviewResponse {
  totalUsers: number;
  newUsersToday: number;
  newUsersThisWeek: number;
  totalWorkspaces: number;
  activeNow: AdminActiveNowCounts;
  systemHealth: AdminOverviewSystemHealth;
  subscriptions: AdminSubscriptionBreakdown;
  usageToday: AdminUsageTodayByPlan[];
  recentActivity: AdminActivityItem[];
}

export interface AdminUserWorkspaceMembership {
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
}

export interface AdminUserDetail extends AdminUserSummary {
  lastActiveAt?: string;
  subscriptionPlan?: SubscriptionPlan;
  workspaces: AdminUserWorkspaceMembership[];
  usageToday: UsageSnapshot[];
}

/* ------------------------------------------------------------------------ */
/* Phase 16/C — real, per-user Git provider authorization (migration 013).  */
/* GitHub App installations first; GitLab/Bitbucket OAuth connections are a */
/* later phase. Never carries a token/secret of any kind — installation_id */
/* is a non-secret GitHub-issued integer, not a credential.                */
/* ------------------------------------------------------------------------ */

export interface ProviderConnectionSummary {
  id: string;
  provider: RepositoryProvider;
  /** Display-only (e.g. the GitHub org/user login) — never an authorization key. */
  externalAccountLogin: string;
  status: 'ACTIVE' | 'REVOKED';
  createdAt: string;
}

export interface ListProviderConnectionsResponse {
  connections: ProviderConnectionSummary[];
}

/* ------------------------------------------------------------------------ */
/* Phase 17 — Stripe billing, subscriptions, entitlements & usage limits. A  */
/* subscription belongs to an ORGANIZATION (see Organization above), not a  */
/* user directly — for a personal organization that's equivalent to        */
/* per-user billing; for a Team organization it naturally extends to many   */
/* members sharing one plan (migrations 023-025). PLAN_DEFINITIONS is the   */
/* single source of truth for plan pricing/limits/features, consumed by     */
/* BOTH the API (entitlement enforcement, apps/api/src/billing/) and the    */
/* web app (the pricing page) — never duplicate a limit or price anywhere   */
/* else.                                                                    */
/* ------------------------------------------------------------------------ */

export type SubscriptionPlan = 'FREE' | 'DEVELOPER' | 'PRO' | 'TEAM' | 'AGENCY';

export type BillingInterval = 'MONTHLY' | 'ANNUAL';

export type SubscriptionStatus = 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'INCOMPLETE' | 'TRIALING';

/** One row per metered action per organization per UTC day (usage_counters, migration 025). */
export type UsageMetric = 'INSPECTION' | 'AI_QUESTION' | 'SCREENSHOT_TO_CODE';

export interface PlanLimits {
  /** `null` means unlimited — see EntitlementService.checkAndConsumeQuota, which skips the usage-counter write entirely for a null limit. */
  inspectionsPerDay: number | null;
  aiQuestionsPerDay: number | null;
  screenshotToCodePerDay: number | null;
}

export interface PlanDefinition {
  id: SubscriptionPlan;
  name: string;
  tagline: string;
  priceMonthlyUsd: number;
  priceAnnualUsd: number;
  limits: PlanLimits;
  /** TEAM/AGENCY only — every other plan is fixed at 1 seat. */
  includedSeats: number;
  extraSeatPriceMonthlyUsd: number | null;
  features: string[];
  /** false for a plan that exists in the data model and pricing-page copy but cannot actually be purchased yet — POST /billing/checkout rejects an inactive plan with INVALID_PLAN. Only AGENCY is inactive today. */
  active: boolean;
}

export const PLAN_DEFINITIONS: Record<SubscriptionPlan, PlanDefinition> = {
  FREE: {
    id: 'FREE',
    name: 'Free',
    tagline: 'Try Origami Lens on your own site',
    priceMonthlyUsd: 0,
    priceAnnualUsd: 0,
    limits: { inspectionsPerDay: 5, aiQuestionsPerDay: 5, screenshotToCodePerDay: 2 },
    includedSeats: 1,
    extraSeatPriceMonthlyUsd: null,
    features: ['5 inspections/day', '5 AI questions/day', '2 Screenshot→Code/day', 'Community support'],
    active: true,
  },
  DEVELOPER: {
    id: 'DEVELOPER',
    name: 'Developer',
    tagline: 'For individual developers shipping fast',
    priceMonthlyUsd: 19,
    priceAnnualUsd: 190,
    limits: { inspectionsPerDay: 50, aiQuestionsPerDay: 50, screenshotToCodePerDay: 20 },
    includedSeats: 1,
    extraSeatPriceMonthlyUsd: null,
    features: ['50 inspections/day', '50 AI questions/day', '20 Screenshot→Code/day', 'Email support'],
    active: true,
  },
  PRO: {
    id: 'PRO',
    name: 'Pro',
    tagline: 'For professionals who ship every day',
    priceMonthlyUsd: 49,
    priceAnnualUsd: 490,
    limits: { inspectionsPerDay: 200, aiQuestionsPerDay: 200, screenshotToCodePerDay: 100 },
    includedSeats: 1,
    extraSeatPriceMonthlyUsd: null,
    features: ['200 inspections/day', '200 AI questions/day', '100 Screenshot→Code/day', 'Priority support'],
    active: true,
  },
  TEAM: {
    id: 'TEAM',
    name: 'Team',
    tagline: 'For teams collaborating on quality',
    priceMonthlyUsd: 99,
    priceAnnualUsd: 990,
    limits: { inspectionsPerDay: null, aiQuestionsPerDay: null, screenshotToCodePerDay: null },
    includedSeats: 3,
    extraSeatPriceMonthlyUsd: 4,
    features: [
      'Unlimited inspections',
      'Unlimited AI questions',
      'Unlimited Screenshot→Code',
      '3 seats included, $4/extra seat/month',
      'Priority support',
    ],
    active: true,
  },
  AGENCY: {
    id: 'AGENCY',
    name: 'Agency',
    tagline: 'For agencies managing many client sites (coming soon)',
    priceMonthlyUsd: 249,
    priceAnnualUsd: 2490,
    limits: { inspectionsPerDay: null, aiQuestionsPerDay: null, screenshotToCodePerDay: null },
    includedSeats: 10,
    extraSeatPriceMonthlyUsd: 4,
    features: ['Everything in Team', 'Multi-client workspace management', 'White-label reports', 'Dedicated support'],
    active: false,
  },
};

/** India-specific pricing overlay — prepared, not yet surfaced anywhere (gated server-side by ENABLE_INDIA_PRICING; see .env.example). A plan absent here has no regional override. */
export const INDIA_PRICE_OVERRIDES_INR: Partial<Record<SubscriptionPlan, { priceMonthlyInr: number; priceAnnualInr: number }>> = {
  DEVELOPER: { priceMonthlyInr: 799, priceAnnualInr: 7990 },
  PRO: { priceMonthlyInr: 1999, priceAnnualInr: 19990 },
  TEAM: { priceMonthlyInr: 3999, priceAnnualInr: 39990 },
};

export interface Subscription {
  organizationId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  billingInterval: BillingInterval | null;
  seatCount: number;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
}

export interface UsageSnapshot {
  metric: UsageMetric;
  count: number;
  limit: number | null;
}

/** The one place plan logic resolves into concrete numbers — routes/middleware consume this, never PLAN_DEFINITIONS or `plan` directly. See apps/api/src/billing/entitlement-service.ts. */
export interface Entitlements {
  plan: SubscriptionPlan;
  limits: PlanLimits;
  seatsIncluded: number;
  seatsUsed: number;
}

export interface BillingStatusResponse {
  subscription: Subscription;
  entitlements: Entitlements;
  usageToday: UsageSnapshot[];
  /** false when STRIPE_SECRET_KEY is unset — the billing settings page uses this to explain why "Manage billing"/"Upgrade" are disabled rather than letting the click fail with a confusing error. */
  billingConfigured: boolean;
}

export interface CreateCheckoutSessionRequest {
  plan: SubscriptionPlan;
  interval: BillingInterval;
  /** TEAM only — total seats desired, including the included seats. Ignored for every other plan. */
  seats?: number;
}

export interface CreateCheckoutSessionResponse {
  url: string;
}

export interface CreateBillingPortalSessionResponse {
  url: string;
}

export interface UpdateSeatsRequest {
  seats: number;
}

export type BillingErrorCode =
  | 'BILLING_NOT_CONFIGURED'
  | 'USAGE_LIMIT_EXCEEDED'
  | 'INVALID_PLAN'
  | 'SEAT_COUNT_INVALID'
  | 'CHECKOUT_SESSION_NOT_FOUND'
  | 'ORGANIZATION_NOT_FOUND';
