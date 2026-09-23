import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Repository, RepositoryAskResponse, RepositoryIssue, RepositoryIssueSeverity, RepositorySearchResponse, RepositoryStatus } from '@origami/contracts';
import {
  askRepository,
  cancelRepositoryClone,
  cancelRepositoryEmbedding,
  cancelRepositoryIndex,
  cloneRepository,
  createRepositoryIssue,
  deleteRepository,
  embedRepository,
  fetchCloneStatus,
  fetchEmbedStatus,
  fetchIndexStatus,
  fetchIndexSummary,
  fetchRepository,
  fetchRepositoryIssues,
  indexRepository,
  searchRepository,
  type RepositoryCloneStatusResponse,
  type RepositoryEmbeddingStatusResponse,
  type RepositoryIndexStatusResponse,
  type RepositoryIndexSummaryResponse,
} from '../api/client';
import { HealthBanner } from '../components/HealthBanner';
import { ErrorState, LoadingSkeleton } from '../components/StateViews';
import { AnimatedProgressBar } from '../components/AnimatedProgressBar';
import {
  GitHubIcon,
  GitLabIcon,
  BitbucketIcon,
  GitBranchIcon,
  MoreIcon,
  ExternalLinkIcon,
  TrashIcon,
  DownloadIcon,
  ListIcon,
  SparkleIcon,
  SearchIcon,
  MessageIcon,
  FolderIcon,
  BookIcon,
  DocumentIcon,
  DatabaseIcon,
  CubeIcon,
  CheckCircleIcon,
  ClockIcon,
  AlertTriangleIcon,
  ArrowRightIcon,
} from '../components/icons';
import { lensEvent } from '../notifications/lens-event';
import { confirm } from '../notifications/confirm';
import { useWorkspaceRole } from '../hooks/useWorkspaceRole';
import { canConfigureRepository, canRunScanOrAI } from '../utils/workspace-permissions';

const PROVIDER_LABEL: Record<Repository['provider'], string> = { GITHUB: 'GitHub', GITLAB: 'GitLab', BITBUCKET: 'Bitbucket' };
const PROVIDER_ICON: Record<Repository['provider'], ComponentType> = { GITHUB: GitHubIcon, GITLAB: GitLabIcon, BITBUCKET: BitbucketIcon };

type StageTone = 'ready' | 'processing' | 'pending' | 'failed' | 'inactive';
interface StageMeta { label: string; tone: StageTone; }

const STATUS_META: Record<RepositoryStatus, StageMeta> = {
  CONNECTED: { label: 'Connected', tone: 'pending' },
  DISCONNECTED: { label: 'Disconnected', tone: 'inactive' },
  CLONING: { label: 'Cloning', tone: 'processing' },
  READY_FOR_INDEXING: { label: 'Ready for indexing', tone: 'pending' },
  FAILED: { label: 'Failed', tone: 'failed' },
  INDEXING: { label: 'Indexing', tone: 'processing' },
  READY_FOR_SEARCH: { label: 'Ready for search', tone: 'pending' },
  EMBEDDING: { label: 'Embedding', tone: 'processing' },
  EMBEDDINGS_READY: { label: 'Embeddings ready', tone: 'ready' },
};

const CLONE_STAGE_META: Record<RepositoryCloneStatusResponse['status'], StageMeta> = {
  QUEUED: { label: 'Queued', tone: 'pending' },
  RUNNING: { label: 'Cloning…', tone: 'processing' },
  COMPLETED: { label: 'Completed', tone: 'ready' },
  FAILED: { label: 'Failed', tone: 'failed' },
  CANCELLED: { label: 'Cancelled', tone: 'inactive' },
  TIMED_OUT: { label: 'Timed out', tone: 'failed' },
};

const INDEX_STAGE_META: Record<RepositoryIndexStatusResponse['status'], StageMeta> = {
  QUEUED: { label: 'Queued', tone: 'pending' },
  RUNNING: { label: 'Indexing…', tone: 'processing' },
  COMPLETED: { label: 'Completed', tone: 'ready' },
  FAILED: { label: 'Failed', tone: 'failed' },
  CANCELLED: { label: 'Cancelled', tone: 'inactive' },
};

const EMBED_STAGE_META: Record<RepositoryEmbeddingStatusResponse['status'], StageMeta> = {
  QUEUED: { label: 'Queued', tone: 'pending' },
  RUNNING: { label: 'Embedding…', tone: 'processing' },
  COMPLETED: { label: 'Completed', tone: 'ready' },
  FAILED: { label: 'Failed', tone: 'failed' },
  CANCELLED: { label: 'Cancelled', tone: 'inactive' },
};

const NOT_STARTED_META: StageMeta = { label: 'Not started', tone: 'inactive' };
const WAITING_META: StageMeta = { label: 'Waiting', tone: 'inactive' };
const READY_META: StageMeta = { label: 'Ready', tone: 'ready' };

const CLONE_IN_PROGRESS = new Set(['QUEUED', 'RUNNING']);
const INDEX_IN_PROGRESS = new Set(['QUEUED', 'RUNNING']);
const EMBED_IN_PROGRESS = new Set(['QUEUED', 'RUNNING']);

const SEVERITY_BADGE_CLASS: Record<RepositoryIssueSeverity, string> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

const STRUCTURE_PREVIEW_LIMIT = 10;

const SEARCH_SUGGESTIONS = [
  'Where is authentication handled?',
  'How are API requests structured?',
  'Where is the database configured?',
  'How does the application handle errors?',
];

const ASK_SUGGESTIONS = [
  'What does this repository do?',
  'How is the health score calculated?',
  'Where should I start reading the code?',
  'What are the main entry points?',
];

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function repoName(repoUrl: string): string {
  try {
    return new URL(repoUrl).pathname.replace(/^\//, '');
  } catch {
    return repoUrl;
  }
}

const LANGUAGE_LABEL: Record<string, string> = {
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  jsx: 'JSX',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  rust: 'Rust',
  c: 'C',
  cpp: 'C++',
  css: 'CSS',
  json: 'JSON',
};

interface ActionItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/** Portal-based "•••" menu, same pattern used across this session's redesigns — this page's root also sits inside `.animate-in`, which traps position:fixed descendants unless portaled. */
function RowActionsMenu({ items, ariaLabel, busy }: { items: ActionItem[]; ariaLabel: string; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const updatePosition = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    };
    updatePosition();
    const handleLayoutChange = () => setOpen(false);
    window.addEventListener('scroll', handleLayoutChange, true);
    window.addEventListener('resize', handleLayoutChange);
    return () => {
      window.removeEventListener('scroll', handleLayoutChange, true);
      window.removeEventListener('resize', handleLayoutChange);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="repo-actions-menu-container" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="repo-actions-trigger repo-detail-more-trigger"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <MoreIcon />
      </button>

      {open && position &&
        createPortal(
          <div ref={menuRef} className="repo-actions-menu" role="menu" aria-label={ariaLabel} style={{ position: 'fixed', top: position.top, right: position.right }}>
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={`repo-actions-menu-item ${item.destructive ? 'destructive' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

interface PipelineStageAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  variant?: 'primary' | 'ghost';
}

function PipelineStage({ icon: Icon, label, meta, timestamp, hint, action }: {
  icon: ComponentType;
  label: string;
  meta: StageMeta;
  timestamp?: string;
  hint?: string;
  action?: PipelineStageAction | null;
}) {
  return (
    <div className="repo-pipeline-stage">
      <span className={`repo-pipeline-stage-icon ${meta.tone}`} aria-hidden="true"><Icon /></span>
      <div className="repo-pipeline-stage-body">
        <span className="repo-pipeline-stage-label">{label}</span>
        <span className={`repo-pipeline-stage-status ${meta.tone}`}>{meta.label}</span>
        {timestamp && <span className="repo-pipeline-stage-timestamp">{formatDateTime(timestamp)}</span>}
        {hint && <span className="repo-pipeline-stage-hint">{hint}</span>}
      </div>
      {action && (
        <button
          type="button"
          className={action.variant === 'primary' ? 'primary-button repo-pipeline-stage-action' : 'ghost-button repo-pipeline-stage-action'}
          onClick={action.onClick}
          disabled={action.disabled}
          title={action.disabledReason}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function PipelineArrow() {
  return <span className="repo-pipeline-arrow" aria-hidden="true"><ArrowRightIcon /></span>;
}

export function RepositoryDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { role } = useWorkspaceRole();
  const canConfigure = canConfigureRepository(role);
  const canAskAI = canRunScanOrAI(role);

  const [repository, setRepository] = useState<Repository | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingRepo, setDeletingRepo] = useState(false);

  const [cloneStatus, setCloneStatus] = useState<RepositoryCloneStatusResponse | null>(null);
  const [cloneActionError, setCloneActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const [indexStatus, setIndexStatus] = useState<RepositoryIndexStatusResponse | null>(null);
  const [indexSummary, setIndexSummary] = useState<RepositoryIndexSummaryResponse | null>(null);
  const [indexActionError, setIndexActionError] = useState<string | null>(null);
  const [startingIndex, setStartingIndex] = useState(false);
  const [cancellingIndex, setCancellingIndex] = useState(false);

  const [embedStatus, setEmbedStatus] = useState<RepositoryEmbeddingStatusResponse | null>(null);
  const [embedActionError, setEmbedActionError] = useState<string | null>(null);
  const [startingEmbed, setStartingEmbed] = useState(false);
  const [cancellingEmbed, setCancellingEmbed] = useState(false);

  const [intelMode, setIntelMode] = useState<'search' | 'ask'>('search');

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResponse, setSearchResponse] = useState<RepositorySearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const [askQuery, setAskQuery] = useState('');
  const [askResponse, setAskResponse] = useState<RepositoryAskResponse | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [hasAsked, setHasAsked] = useState(false);

  const [structureExpanded, setStructureExpanded] = useState(false);

  const [issues, setIssues] = useState<RepositoryIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [showCreateIssueForm, setShowCreateIssueForm] = useState(false);
  const [issueTitle, setIssueTitle] = useState('');
  const [issueDescription, setIssueDescription] = useState('');
  const [issueFilePath, setIssueFilePath] = useState('');
  const [issueSymbol, setIssueSymbol] = useState('');
  const [issueSeverity, setIssueSeverity] = useState<RepositoryIssueSeverity>('MEDIUM');
  const [creatingIssue, setCreatingIssue] = useState(false);
  const [createIssueError, setCreateIssueError] = useState<string | null>(null);

  const load = () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    fetchRepository(id)
      .then(setRepository)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load repository'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [id]);

  // Tracks each job's own Lens Active card + last-seen status, so the
  // active->complete morph fires only on a REAL in-progress -> terminal
  // transition observed during this page visit — never for a job that was
  // already terminal on the very first load. No progress field exists for
  // any of these three job types today (unlike website scans), so their
  // cards stay indeterminate the whole time — never a fabricated percentage.
  const cloneStatusRef = useRef<string | undefined>(undefined);
  const indexStatusRef = useRef<string | undefined>(undefined);
  const embedStatusRef = useRef<string | undefined>(undefined);
  const cloneEventIdRef = useRef<string | null>(null);
  const indexEventIdRef = useRef<string | null>(null);
  const embedEventIdRef = useRef<string | null>(null);

  const repoResource = repository ? repoName(repository.repoUrl) : undefined;

  const loadCloneStatus = useCallback(async () => {
    if (!id) return;
    try {
      const status = await fetchCloneStatus(id);
      setCloneStatus(status);
      const wasInProgress = cloneStatusRef.current !== undefined && CLONE_IN_PROGRESS.has(cloneStatusRef.current);
      const nowInProgress = CLONE_IN_PROGRESS.has(status.status);
      if (nowInProgress && !cloneEventIdRef.current) {
        cloneEventIdRef.current = lensEvent.active({ title: 'Cloning repository', resource: repoResource });
      } else if (wasInProgress && !nowInProgress && cloneEventIdRef.current) {
        const eventId = cloneEventIdRef.current;
        cloneEventIdRef.current = null;
        if (status.status === 'COMPLETED') lensEvent.complete(eventId, { type: 'success', title: 'Repository cloned', resource: repoResource });
        else if (status.status === 'FAILED') lensEvent.complete(eventId, { type: 'error', title: 'Repository clone failed', resource: repoResource });
        else if (status.status === 'CANCELLED') lensEvent.complete(eventId, { type: 'warning', title: 'Repository clone cancelled', resource: repoResource });
        else if (status.status === 'TIMED_OUT') lensEvent.complete(eventId, { type: 'error', title: 'Repository clone timed out', resource: repoResource, detail: 'Please try again.' });
      }
      cloneStatusRef.current = status.status;
    } catch {
      setCloneStatus(null);
    }
  }, [id, repoResource]);

  const loadIndexStatus = useCallback(async () => {
    if (!id) return;
    try {
      const status = await fetchIndexStatus(id);
      setIndexStatus(status);
      const wasInProgress = indexStatusRef.current !== undefined && INDEX_IN_PROGRESS.has(indexStatusRef.current);
      const nowInProgress = INDEX_IN_PROGRESS.has(status.status);
      if (nowInProgress && !indexEventIdRef.current) {
        indexEventIdRef.current = lensEvent.active({ title: 'Indexing repository', resource: repoResource });
      } else if (wasInProgress && !nowInProgress && indexEventIdRef.current) {
        const eventId = indexEventIdRef.current;
        indexEventIdRef.current = null;
        if (status.status === 'COMPLETED') lensEvent.complete(eventId, { type: 'success', title: 'Repository indexing completed', resource: repoResource });
        else if (status.status === 'FAILED') lensEvent.complete(eventId, { type: 'error', title: 'Repository indexing failed', resource: repoResource });
        else if (status.status === 'CANCELLED') lensEvent.complete(eventId, { type: 'warning', title: 'Repository indexing cancelled', resource: repoResource });
      }
      indexStatusRef.current = status.status;
      if (status.status === 'COMPLETED') {
        setIndexSummary(await fetchIndexSummary(id).catch(() => null));
      } else {
        setIndexSummary(null);
      }
    } catch {
      setIndexStatus(null);
      setIndexSummary(null);
    }
  }, [id, repoResource]);

  const loadEmbedStatus = useCallback(async () => {
    if (!id) return;
    try {
      const status = await fetchEmbedStatus(id);
      setEmbedStatus(status);
      const wasInProgress = embedStatusRef.current !== undefined && EMBED_IN_PROGRESS.has(embedStatusRef.current);
      const nowInProgress = EMBED_IN_PROGRESS.has(status.status);
      if (nowInProgress && !embedEventIdRef.current) {
        embedEventIdRef.current = lensEvent.active({ title: 'Embedding repository', resource: repoResource });
      } else if (wasInProgress && !nowInProgress && embedEventIdRef.current) {
        const eventId = embedEventIdRef.current;
        embedEventIdRef.current = null;
        if (status.status === 'COMPLETED') lensEvent.complete(eventId, { type: 'success', title: 'Repository embeddings ready', resource: repoResource });
        else if (status.status === 'FAILED') lensEvent.complete(eventId, { type: 'error', title: 'Repository embedding failed', resource: repoResource });
        else if (status.status === 'CANCELLED') lensEvent.complete(eventId, { type: 'warning', title: 'Repository embedding cancelled', resource: repoResource });
      }
      embedStatusRef.current = status.status;
    } catch {
      setEmbedStatus(null);
    }
  }, [id, repoResource]);

  const loadIssues = useCallback(async () => {
    if (!id) return;
    setLoadingIssues(true);
    setIssuesError(null);
    try {
      const response = await fetchRepositoryIssues(id);
      setIssues(response.issues);
    } catch (err) {
      setIssuesError(err instanceof Error ? err.message : 'Failed to load issues');
    } finally {
      setLoadingIssues(false);
    }
  }, [id]);

  useEffect(() => {
    loadCloneStatus();
    loadIndexStatus();
    loadEmbedStatus();
  }, [loadCloneStatus, loadIndexStatus, loadEmbedStatus]);

  useEffect(() => {
    if (indexStatus?.status === 'COMPLETED') loadIssues();
  }, [indexStatus?.status, loadIssues]);

  useEffect(() => {
    if (!cloneStatus || !CLONE_IN_PROGRESS.has(cloneStatus.status)) return;
    const interval = setInterval(loadCloneStatus, 2000);
    return () => clearInterval(interval);
  }, [cloneStatus, loadCloneStatus]);

  useEffect(() => {
    if (!indexStatus || !INDEX_IN_PROGRESS.has(indexStatus.status)) return;
    const interval = setInterval(loadIndexStatus, 2000);
    return () => clearInterval(interval);
  }, [indexStatus, loadIndexStatus]);

  useEffect(() => {
    if (!embedStatus || !EMBED_IN_PROGRESS.has(embedStatus.status)) return;
    const interval = setInterval(loadEmbedStatus, 2000);
    return () => clearInterval(interval);
  }, [embedStatus, loadEmbedStatus]);

  const handleStartClone = async () => {
    if (!id || starting) return;
    setCloneActionError(null);
    setStarting(true);
    try {
      await cloneRepository(id);
      await loadCloneStatus();
      load();
    } catch (err) {
      setCloneActionError(err instanceof Error ? err.message : 'Failed to start clone');
    } finally {
      setStarting(false);
    }
  };

  const handleCancelClone = async () => {
    if (!id || cancelling) return;
    setCancelling(true);
    try {
      await cancelRepositoryClone(id);
      await loadCloneStatus();
      load();
    } catch (err) {
      setCloneActionError(err instanceof Error ? err.message : 'Failed to cancel clone');
    } finally {
      setCancelling(false);
    }
  };

  const handleStartIndex = async () => {
    if (!id || startingIndex) return;
    setIndexActionError(null);
    setStartingIndex(true);
    try {
      await indexRepository(id);
      await loadIndexStatus();
      load();
    } catch (err) {
      setIndexActionError(err instanceof Error ? err.message : 'Failed to start indexing');
    } finally {
      setStartingIndex(false);
    }
  };

  const handleCancelIndex = async () => {
    if (!id || cancellingIndex) return;
    setCancellingIndex(true);
    try {
      await cancelRepositoryIndex(id);
      await loadIndexStatus();
      load();
    } catch (err) {
      setIndexActionError(err instanceof Error ? err.message : 'Failed to cancel indexing');
    } finally {
      setCancellingIndex(false);
    }
  };

  const handleStartEmbed = async () => {
    if (!id || startingEmbed) return;
    setEmbedActionError(null);
    setStartingEmbed(true);
    try {
      await embedRepository(id);
      await loadEmbedStatus();
      load();
    } catch (err) {
      setEmbedActionError(err instanceof Error ? err.message : 'Failed to start embedding');
    } finally {
      setStartingEmbed(false);
    }
  };

  const handleCancelEmbed = async () => {
    if (!id || cancellingEmbed) return;
    setCancellingEmbed(true);
    try {
      await cancelRepositoryEmbedding(id);
      await loadEmbedStatus();
      load();
    } catch (err) {
      setEmbedActionError(err instanceof Error ? err.message : 'Failed to cancel embedding');
    } finally {
      setCancellingEmbed(false);
    }
  };

  const handleDeleteRepository = async () => {
    if (!id || !repository || deletingRepo) return;
    const confirmed = await confirm({
      title: 'Delete repository?',
      description: `Delete ${repoName(repository.repoUrl)}? This also removes its indexing/embedding data and clone workspace. This cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    setDeletingRepo(true);
    try {
      await deleteRepository(id);
      lensEvent.success('Repository deleted', { resource: repoName(repository.repoUrl) });
      navigate('/repositories');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete repository');
      setDeletingRepo(false);
    }
  };

  const handleCreateIssue = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!id || creatingIssue) return;
    const trimmedTitle = issueTitle.trim();
    const trimmedDescription = issueDescription.trim();
    if (!trimmedTitle || !trimmedDescription) {
      setCreateIssueError('Title and description are required.');
      return;
    }
    setCreatingIssue(true);
    setCreateIssueError(null);
    try {
      await createRepositoryIssue(id, {
        title: trimmedTitle,
        description: trimmedDescription,
        severity: issueSeverity,
        filePath: issueFilePath.trim() || undefined,
        symbol: issueSymbol.trim() || undefined,
      });
      setIssueTitle('');
      setIssueDescription('');
      setIssueFilePath('');
      setIssueSymbol('');
      setIssueSeverity('MEDIUM');
      setShowCreateIssueForm(false);
      await loadIssues();
    } catch (err) {
      setCreateIssueError(err instanceof Error ? err.message : 'Failed to create issue');
    } finally {
      setCreatingIssue(false);
    }
  };

  const runSearch = async (query: string) => {
    if (!id || searching) return;
    setSearching(true);
    setSearchError(null);
    try {
      const response = await searchRepository(id, query);
      setSearchResponse(response);
      setHasSearched(true);
    } catch (err) {
      setSearchResponse(null);
      setHasSearched(true);
      setSearchError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  const handleSearch = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchError('Enter a search query.');
      return;
    }
    await runSearch(trimmed);
  };

  const handleSuggestedSearch = (q: string) => {
    setSearchQuery(q);
    void runSearch(q);
  };

  const runAsk = async (query: string) => {
    if (!id || asking) return;
    setAsking(true);
    setAskError(null);
    try {
      const response = await askRepository(id, query);
      setAskResponse(response);
      setHasAsked(true);
    } catch (err) {
      setAskResponse(null);
      setHasAsked(true);
      setAskError(err instanceof Error ? err.message : 'Failed to get an answer');
    } finally {
      setAsking(false);
    }
  };

  const handleAsk = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const trimmed = askQuery.trim();
    if (!trimmed) {
      setAskError('Enter a question.');
      return;
    }
    await runAsk(trimmed);
  };

  const handleSuggestedAsk = (q: string) => {
    setAskQuery(q);
    void runAsk(q);
  };

  const severityCounts = useMemo(() => {
    const counts: Record<RepositoryIssueSeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const issue of issues) counts[issue.severity] += 1;
    return counts;
  }, [issues]);

  if (loading) {
    return (
      <div className="dashboard repository-detail-page">
        <LoadingSkeleton />
      </div>
    );
  }

  if (error || !repository) {
    return (
      <div className="dashboard repository-detail-page">
        <ErrorState message={error ?? 'Repository not found'} onRetry={load} />
        <Link to="/repositories" className="back-link">← Back to Repositories</Link>
      </div>
    );
  }

  const cloneInProgress = Boolean(cloneStatus && CLONE_IN_PROGRESS.has(cloneStatus.status));
  const cloneReady = cloneStatus?.status === 'COMPLETED';
  const indexInProgress = Boolean(indexStatus && INDEX_IN_PROGRESS.has(indexStatus.status));
  const indexReady = indexStatus?.status === 'COMPLETED';
  const embedInProgress = Boolean(embedStatus && EMBED_IN_PROGRESS.has(embedStatus.status));
  const embedReady = embedStatus?.status === 'COMPLETED';
  const ProviderIcon = PROVIDER_ICON[repository.provider];
  const notConfigureReason = 'Only workspace owners and admins can do this.';

  const topDirs = cloneStatus?.topLevelDirectories ?? [];
  const topFiles = cloneStatus?.topLevelFiles ?? [];
  const allTopLevel = [
    ...topDirs.map((d) => ({ type: 'dir' as const, name: d })),
    ...topFiles.map((f) => ({ type: 'file' as const, name: f })),
  ];
  const visibleTopLevel = structureExpanded ? allTopLevel : allTopLevel.slice(0, STRUCTURE_PREVIEW_LIMIT);

  const languageEntries = indexSummary ? Object.entries(indexSummary.languages).sort(([, a], [, b]) => b - a) : [];
  const languageTotal = languageEntries.reduce((sum, [, c]) => sum + c, 0);

  return (
    <div className="dashboard repository-detail-page animate-in">
      <Link to="/repositories" className="back-link">← Back to Repositories</Link>

      <div className="component-header repo-detail-header">
        <div className="component-header-identity">
          <span className="component-header-icon repo-detail-provider-icon" aria-hidden="true"><ProviderIcon /></span>
          <div>
            <div className="page-eyebrow">{PROVIDER_LABEL[repository.provider]}</div>
            <h1>{repoName(repository.repoUrl)}</h1>
            <div className="detail-tags repo-detail-tags">
              <a href={repository.repoUrl} target="_blank" rel="noreferrer">{repository.repoUrl}</a>
              <span className="repo-detail-branch"><GitBranchIcon /> {repository.branch}</span>
              {cloneStatus?.commitSha && <span className="repo-detail-commit">{cloneStatus.commitSha.slice(0, 7)}</span>}
              <span className={`repo-status-pill ${STATUS_META[repository.status].tone}`}>
                <span className="repo-status-dot" aria-hidden="true" />
                {STATUS_META[repository.status].label}
              </span>
            </div>
          </div>
        </div>

        <div className="component-header-actions">
          <button type="button" className="ghost-button" onClick={() => window.open(repository.repoUrl, '_blank', 'noopener,noreferrer')}>
            <ExternalLinkIcon /> Open Repository
          </button>
          <RowActionsMenu
            ariaLabel="Repository actions"
            busy={deletingRepo}
            items={[
              {
                label: 'Delete repository',
                destructive: true,
                disabled: !canConfigure || deletingRepo,
                onClick: () => void handleDeleteRepository(),
              },
            ]}
          />
        </div>
      </div>

      <section className="repo-pipeline-section">
        <div className="repo-panel-header">
          <span className="repo-panel-icon" aria-hidden="true"><SparkleIcon /></span>
          <div>
            <h2>Repository Intelligence Pipeline</h2>
            <p>From code to insights — your repository is ready for AI analysis.</p>
          </div>
        </div>

        {cloneActionError && <p className="connect-repo-error" role="alert">{cloneActionError}</p>}
        {indexActionError && <p className="connect-repo-error" role="alert">{indexActionError}</p>}
        {embedActionError && <p className="connect-repo-error" role="alert">{embedActionError}</p>}

        <div className="repo-pipeline-track">
          <PipelineStage
            icon={DownloadIcon}
            label="Clone"
            meta={cloneStatus ? CLONE_STAGE_META[cloneStatus.status] : NOT_STARTED_META}
            timestamp={cloneStatus?.completedAt}
            action={
              cloneInProgress
                ? { label: cancelling ? 'Cancelling…' : 'Cancel', onClick: handleCancelClone, disabled: cancelling }
                : {
                    label: starting ? 'Starting…' : cloneStatus ? 'Clone Again' : 'Clone Repository',
                    onClick: handleStartClone,
                    disabled: starting || !canConfigure,
                    disabledReason: canConfigure ? undefined : notConfigureReason,
                    variant: cloneStatus ? 'ghost' : 'primary',
                  }
            }
          />
          <PipelineArrow />
          <PipelineStage
            icon={ListIcon}
            label="Index"
            meta={!cloneReady ? WAITING_META : indexStatus ? INDEX_STAGE_META[indexStatus.status] : NOT_STARTED_META}
            timestamp={indexStatus?.completedAt}
            hint={!cloneReady ? 'Waiting for clone to finish' : undefined}
            action={
              !cloneReady
                ? null
                : indexInProgress
                ? { label: cancellingIndex ? 'Cancelling…' : 'Cancel', onClick: handleCancelIndex, disabled: cancellingIndex }
                : {
                    label: startingIndex ? 'Starting…' : indexStatus ? 'Index Again' : 'Index Repository',
                    onClick: handleStartIndex,
                    disabled: startingIndex || !canConfigure,
                    disabledReason: canConfigure ? undefined : notConfigureReason,
                    variant: indexStatus ? 'ghost' : 'primary',
                  }
            }
          />
          <PipelineArrow />
          <PipelineStage
            icon={SparkleIcon}
            label="Embeddings"
            meta={!indexReady ? WAITING_META : embedStatus ? EMBED_STAGE_META[embedStatus.status] : NOT_STARTED_META}
            timestamp={embedStatus?.completedAt}
            hint={!indexReady ? 'Waiting for index to finish' : undefined}
            action={
              !indexReady
                ? null
                : embedInProgress
                ? { label: cancellingEmbed ? 'Cancelling…' : 'Cancel', onClick: handleCancelEmbed, disabled: cancellingEmbed }
                : {
                    label: startingEmbed ? 'Starting…' : embedStatus ? 'Generate Again' : 'Generate Embeddings',
                    onClick: handleStartEmbed,
                    disabled: startingEmbed || !canConfigure,
                    disabledReason: canConfigure ? undefined : notConfigureReason,
                    variant: embedStatus ? 'ghost' : 'primary',
                  }
            }
          />
          <PipelineArrow />
          <PipelineStage icon={SearchIcon} label="Search" meta={embedReady ? READY_META : WAITING_META} hint={embedReady ? 'Semantic search enabled' : undefined} />
          <PipelineArrow />
          <PipelineStage icon={MessageIcon} label="AI Assistant" meta={embedReady ? READY_META : WAITING_META} hint={embedReady ? 'Ask questions about this repo' : undefined} />
        </div>
      </section>

      <div className="repo-summary-grid repo-detail-metrics-grid">
        <div className="repo-summary-tile">
          <span className="repo-summary-tile-icon total" aria-hidden="true"><DocumentIcon /></span>
          <div>
            <span className="repo-summary-tile-count">{typeof cloneStatus?.fileCount === 'number' ? cloneStatus.fileCount : '—'}</span>
            <span className="repo-summary-tile-label">Files</span>
          </div>
        </div>
        <div className="repo-summary-tile">
          <span className="repo-summary-tile-icon processing" aria-hidden="true"><FolderIcon /></span>
          <div>
            <span className="repo-summary-tile-count">{typeof cloneStatus?.directoryCount === 'number' ? cloneStatus.directoryCount : '—'}</span>
            <span className="repo-summary-tile-label">Directories</span>
          </div>
        </div>
        <div className="repo-summary-tile">
          <span className="repo-summary-tile-icon ready" aria-hidden="true"><CubeIcon /></span>
          <div>
            <span className="repo-summary-tile-count">{typeof indexStatus?.chunksCreated === 'number' && indexReady ? indexStatus.chunksCreated : '—'}</span>
            <span className="repo-summary-tile-label">Code Chunks</span>
          </div>
        </div>
        <div className="repo-summary-tile">
          <span className="repo-summary-tile-icon total" aria-hidden="true"><DatabaseIcon /></span>
          <div>
            <span className="repo-summary-tile-count">{typeof cloneStatus?.totalSizeBytes === 'number' ? formatBytes(cloneStatus.totalSizeBytes) : '—'}</span>
            <span className="repo-summary-tile-label">Repository Size</span>
          </div>
        </div>
      </div>

      {cloneReady && (
        <div className="repo-detail-columns">
          <section className="repo-intelligence-panel">
            <div className="repo-panel-header">
              <span className="repo-panel-icon" aria-hidden="true"><SparkleIcon /></span>
              <div>
                <h2>Repository Intelligence</h2>
                <p>Search your code or ask a question about this repository.</p>
              </div>
            </div>

            {!indexReady ? (
              <HealthBanner variant="info">Index this repository (above) to enable search and AI Q&amp;A.</HealthBanner>
            ) : (
              <>
                <div className="workspace-tabs repo-intel-tabs" role="tablist" aria-label="Repository intelligence mode">
                  <button type="button" role="tab" aria-selected={intelMode === 'search'} className={`workspace-tab ${intelMode === 'search' ? 'active' : ''}`} onClick={() => setIntelMode('search')}>
                    <SearchIcon /> Search
                  </button>
                  <button type="button" role="tab" aria-selected={intelMode === 'ask'} className={`workspace-tab ${intelMode === 'ask' ? 'active' : ''}`} onClick={() => setIntelMode('ask')}>
                    <MessageIcon /> Ask AI
                  </button>
                </div>

                {!embedReady && (
                  <HealthBanner variant="info">Generate embeddings for this repository (above) before you can search or ask questions.</HealthBanner>
                )}

                {embedReady && intelMode === 'search' && (
                  <div className="repo-intel-mode">
                    <form className="repository-search-form" onSubmit={handleSearch}>
                      <input
                        type="text"
                        className="search-input"
                        placeholder="Search code, files, functions, or ask a question…"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        aria-label="Repository search query"
                      />
                      <button type="submit" className="primary-button" disabled={searching}>
                        {searching ? 'Searching…' : 'Search'}
                      </button>
                    </form>

                    {!hasSearched && (
                      <div className="repo-suggested-queries">
                        <span className="repo-suggested-queries-label">Try these example questions:</span>
                        {SEARCH_SUGGESTIONS.map((q) => (
                          <button key={q} type="button" className="repo-suggested-query" onClick={() => handleSuggestedSearch(q)}>
                            {q} <ArrowRightIcon />
                          </button>
                        ))}
                      </div>
                    )}

                    {searchError && <p className="connect-repo-error" role="alert">{searchError}</p>}

                    {searching && (
                      <div className="repository-clone-progress">
                        <div className="spinner-inline" aria-hidden="true" />
                        <p className="muted">Embedding your query and searching indexed code…</p>
                      </div>
                    )}

                    {!searching && hasSearched && searchResponse && (
                      <div className="repository-discovery">
                        {searchResponse.reranked === false && (
                          <HealthBanner variant="warning">The reranking model is unavailable right now — showing vector-similarity results only (not reranked).</HealthBanner>
                        )}

                        {searchResponse.results.length === 0 ? (
                          <p className="muted">No matching code found for "{searchResponse.query}".</p>
                        ) : (
                          <ul className="repository-search-results">
                            {searchResponse.results.map((result) => (
                              <li key={result.chunkId} className="repository-search-result">
                                <div className="repository-search-result-header">
                                  <span className="repository-search-result-symbol">{result.symbol}</span>
                                  <span className="badge">{LANGUAGE_LABEL[result.language] ?? result.language}</span>
                                  {typeof result.rerankerScore === 'number' && (
                                    <span className="repository-search-result-score">rerank score {result.rerankerScore.toFixed(3)}</span>
                                  )}
                                </div>
                                <div className="repository-search-result-path">{result.filePath}:{result.startLine}-{result.endLine}</div>
                                {result.content && <pre className="repository-search-result-content"><code>{result.content}</code></pre>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {embedReady && intelMode === 'ask' && (
                  <div className="repo-intel-mode">
                    {!canAskAI ? (
                      <HealthBanner variant="warning">Only workspace owners, admins, and members can ask the AI assistant.</HealthBanner>
                    ) : (
                      <>
                        <form className="repository-search-form" onSubmit={handleAsk}>
                          <input
                            type="text"
                            className="search-input"
                            placeholder="Ask something about this repository…"
                            value={askQuery}
                            onChange={(e) => setAskQuery(e.target.value)}
                            aria-label="Repository assistant question"
                          />
                          <button type="submit" className="primary-button" disabled={asking}>
                            {asking ? 'Asking…' : 'Ask AI'}
                          </button>
                        </form>

                        {!hasAsked && (
                          <div className="repo-suggested-queries">
                            <span className="repo-suggested-queries-label">Try these example questions:</span>
                            {ASK_SUGGESTIONS.map((q) => (
                              <button key={q} type="button" className="repo-suggested-query" onClick={() => handleSuggestedAsk(q)}>
                                {q} <ArrowRightIcon />
                              </button>
                            ))}
                          </div>
                        )}

                        {askError && <p className="connect-repo-error" role="alert">{askError}</p>}

                        {asking && (
                          <div className="repository-clone-progress">
                            <div className="spinner-inline" aria-hidden="true" />
                            <p className="muted">Retrieving relevant code and generating an answer…</p>
                          </div>
                        )}

                        {!asking && hasAsked && askResponse && (
                          <div className="repository-discovery">
                            {askResponse.reranked === false && (
                              <HealthBanner variant="warning">The reranking model is unavailable right now — this answer is based on vector-similarity results only (not reranked).</HealthBanner>
                            )}

                            <div className="repository-ask-answer">
                              <span className="repository-meta-label">Answer</span>
                              <p>{askResponse.answer}</p>
                            </div>

                            {askResponse.sources.length === 0 ? (
                              <p className="muted">No sources — the indexed repository context was not sufficient for a grounded answer.</p>
                            ) : (
                              <div className="repository-ask-sources">
                                <span className="repository-meta-label">Sources</span>
                                <ul className="repository-search-results">
                                  {askResponse.sources.map((source, i) => (
                                    <li key={`${source.filePath}-${source.symbol}-${i}`} className="repository-search-result">
                                      <div className="repository-search-result-header">
                                        <span className="repository-search-result-symbol">{source.symbol}</span>
                                        <span className="badge">{source.symbolType}</span>
                                      </div>
                                      <div className="repository-search-result-path">{source.filePath}:{source.startLine}-{source.endLine}</div>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </section>

          <section className="repo-overview-panel">
            <div className="repo-panel-header">
              <span className="repo-panel-icon" aria-hidden="true"><BookIcon /></span>
              <div>
                <h2>Repository Overview</h2>
                <p>Structure, languages, and key details about this repository.</p>
              </div>
            </div>

            {allTopLevel.length > 0 && (
              <div className="repo-overview-section">
                <div className="repo-overview-section-header">
                  <span>Top-level structure ({allTopLevel.length} items)</span>
                  {allTopLevel.length > STRUCTURE_PREVIEW_LIMIT && (
                    <button type="button" className="repo-view-all-toggle" onClick={() => setStructureExpanded((v) => !v)}>
                      {structureExpanded ? 'Show less' : 'View all'}
                    </button>
                  )}
                </div>
                <div className="repo-structure-chips">
                  {visibleTopLevel.map((entry) => (
                    <span key={`${entry.type}-${entry.name}`} className="repo-structure-chip">
                      {entry.type === 'dir' ? <FolderIcon /> : <DocumentIcon />}
                      {entry.name}{entry.type === 'dir' ? '/' : ''}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {languageEntries.length > 0 && (
              <div className="repo-overview-section">
                <div className="repo-overview-section-header"><span>Language breakdown</span></div>
                <div className="repo-language-bars">
                  {languageEntries.map(([language, count]) => {
                    const pct = languageTotal > 0 ? (count / languageTotal) * 100 : 0;
                    return (
                      <div key={language} className="repo-language-bar-row">
                        <span className="repo-language-name">{LANGUAGE_LABEL[language] ?? language}</span>
                        <AnimatedProgressBar percent={pct} trackClassName="repo-language-bar-track" fillClassName="repo-language-bar-fill" />
                        <span className="repo-language-count">{count}</span>
                        <span className="repo-language-pct">{pct.toFixed(0)}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {allTopLevel.length === 0 && languageEntries.length === 0 && (
              <p className="muted">Structure and language details will appear here once indexing completes.</p>
            )}
          </section>
        </div>
      )}

      {indexReady && (
        <section className="repo-issues-section">
          <div className="repo-panel-header repo-issues-header">
            <span className="repo-panel-icon" aria-hidden="true"><AlertTriangleIcon /></span>
            <div>
              <h2>Repository Issues</h2>
              <p>Code issues found in this repository.</p>
            </div>
            <button type="button" className="primary-button" onClick={() => setShowCreateIssueForm((v) => !v)}>
              {showCreateIssueForm ? 'Cancel' : 'Report Issue'}
            </button>
          </div>

          {issuesError && <p className="connect-repo-error" role="alert">{issuesError}</p>}

          {showCreateIssueForm && (
            <form className="repository-issue-form" onSubmit={handleCreateIssue}>
              <input
                type="text"
                className="search-input"
                placeholder="Title, e.g. “Health score calculation is incorrect”"
                value={issueTitle}
                onChange={(e) => setIssueTitle(e.target.value)}
                aria-label="Issue title"
              />
              <textarea
                className="repository-issue-textarea"
                placeholder="Describe the issue…"
                value={issueDescription}
                onChange={(e) => setIssueDescription(e.target.value)}
                aria-label="Issue description"
                rows={3}
              />
              <div className="repository-issue-form-row">
                <input
                  type="text"
                  className="search-input"
                  placeholder="File path (optional)"
                  value={issueFilePath}
                  onChange={(e) => setIssueFilePath(e.target.value)}
                  aria-label="File path"
                />
                <input
                  type="text"
                  className="search-input"
                  placeholder="Symbol (optional)"
                  value={issueSymbol}
                  onChange={(e) => setIssueSymbol(e.target.value)}
                  aria-label="Symbol"
                />
                <select className="search-input" value={issueSeverity} onChange={(e) => setIssueSeverity(e.target.value as typeof issueSeverity)} aria-label="Severity">
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                  <option value="CRITICAL">Critical</option>
                </select>
              </div>
              {createIssueError && <p className="connect-repo-error" role="alert">{createIssueError}</p>}
              <button type="submit" className="primary-button" disabled={creatingIssue}>
                {creatingIssue ? 'Creating…' : 'Create Issue'}
              </button>
            </form>
          )}

          {loadingIssues ? (
            <div className="repository-clone-progress">
              <div className="spinner-inline" aria-hidden="true" />
              <p className="muted">Loading issues…</p>
            </div>
          ) : issues.length === 0 ? (
            <div className="empty-state-card">
              <span className="empty-state-icon" aria-hidden="true"><CheckCircleIcon /></span>
              <h3>No issues reported yet</h3>
              <p>This repository currently has no reported code issues.</p>
            </div>
          ) : (
            <>
              <div className="repo-issues-summary">
                <span>{issues.length} issue{issues.length === 1 ? '' : 's'}</span>
                {severityCounts.CRITICAL > 0 && <span className="repo-issue-count-chip critical">Critical {severityCounts.CRITICAL}</span>}
                {severityCounts.HIGH > 0 && <span className="repo-issue-count-chip high">High {severityCounts.HIGH}</span>}
                {severityCounts.MEDIUM > 0 && <span className="repo-issue-count-chip medium">Medium {severityCounts.MEDIUM}</span>}
                {severityCounts.LOW > 0 && <span className="repo-issue-count-chip low">Low {severityCounts.LOW}</span>}
              </div>
              <ul className="repo-issue-list">
                {issues.map((issue) => (
                  <li key={issue.id} className="repo-issue-row">
                    <Link to={`/repositories/${id}/issues/${issue.id}`} className="repo-issue-row-link">
                      <span className={`badge ${SEVERITY_BADGE_CLASS[issue.severity]}`}>{issue.severity}</span>
                      <div className="repo-issue-row-body">
                        <span className="repo-issue-row-title">{issue.title}</span>
                        {issue.filePath && (
                          <span className="repo-issue-row-path">
                            {issue.filePath}
                            {typeof issue.lineStart === 'number' ? `:${issue.lineStart}${typeof issue.lineEnd === 'number' && issue.lineEnd !== issue.lineStart ? `-${issue.lineEnd}` : ''}` : ''}
                          </span>
                        )}
                      </div>
                      <span className="repo-issue-row-source">{issue.source === 'AI_DETECTED' ? 'AI detected' : 'User reported'}</span>
                      <span className="repo-issue-row-view">View</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {!indexReady && (
        <HealthBanner variant="info">
          Repository analysis is not available yet. Clone and index this repository (above) to enable search, code chunks, and AI-powered analysis.
        </HealthBanner>
      )}
    </div>
  );
}
