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

export interface Repository {
  id: string;
  /**
   * Legacy, pre-Phase-16 client-supplied identifier — kept only for
   * historical rows, never read for any authorization decision (see
   * migration 012). Real ownership is `userId` below.
   * @deprecated Use `userId`.
   */
  ownerId?: string;
  /** The authenticated Origami Lens user who owns this repository (migration 012) — the only value any ownership check compares against. Undefined for legacy pre-Phase-16 rows, which are therefore unowned and inaccessible. */
  userId?: string;
  repoUrl: string;
  provider: RepositoryProvider;
  branch: string;
  status: RepositoryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRepositoryRequest {
  repoUrl: string;
  /** Optional — defaults to 'main' server-side if omitted. */
  branch?: string;
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
  | 'FIX_PROPOSAL_FAILED';

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

export interface AuthUser {
  id: string;
  primaryProvider: RepositoryProvider;
  /** Display-only (e.g. GitHub login) — never used as an authorization key. */
  primaryProviderLogin: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface AuthMeResponse {
  user: AuthUser | null;
}

export type AuthErrorCode =
  | 'AUTH_NOT_CONFIGURED'
  | 'OAUTH_STATE_MISMATCH'
  | 'OAUTH_EXCHANGE_FAILED'
  | 'UNAUTHENTICATED';

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
