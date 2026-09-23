import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Repository, RepositoryAskResponse, RepositoryIssue, RepositoryIssueSeverity, RepositorySearchResponse } from '@origami/contracts';
import {
  askRepository,
  cancelRepositoryClone,
  cancelRepositoryEmbedding,
  cancelRepositoryIndex,
  cloneRepository,
  createRepositoryIssue,
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

const PROVIDER_LABEL: Record<Repository['provider'], string> = {
  GITHUB: 'GitHub',
  GITLAB: 'GitLab',
  BITBUCKET: 'Bitbucket',
};

const STATUS_LABEL: Record<Repository['status'], string> = {
  CONNECTED: 'Connected',
  DISCONNECTED: 'Disconnected',
  CLONING: 'Cloning',
  READY_FOR_INDEXING: 'Ready for indexing',
  FAILED: 'Failed',
  INDEXING: 'Indexing',
  READY_FOR_SEARCH: 'Ready for search',
  EMBEDDING: 'Embedding',
  EMBEDDINGS_READY: 'Embeddings ready',
};

/** User-facing label for the clone job's own lifecycle — distinct from (and shown alongside) the repository's own status above. */
const CLONE_STATUS_LABEL: Record<RepositoryCloneStatusResponse['status'], string> = {
  QUEUED: 'Queued',
  RUNNING: 'Cloning…',
  COMPLETED: 'Ready for indexing',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  TIMED_OUT: 'Timed out',
};

const INDEX_STATUS_LABEL: Record<RepositoryIndexStatusResponse['status'], string> = {
  QUEUED: 'Queued',
  RUNNING: 'Indexing…',
  COMPLETED: 'Ready for Search',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const EMBED_STATUS_LABEL: Record<RepositoryEmbeddingStatusResponse['status'], string> = {
  QUEUED: 'Queued',
  RUNNING: 'Embedding…',
  COMPLETED: 'Embeddings Ready',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const CLONE_IN_PROGRESS = new Set(['QUEUED', 'RUNNING']);
const INDEX_IN_PROGRESS = new Set(['QUEUED', 'RUNNING']);
const EMBED_IN_PROGRESS = new Set(['QUEUED', 'RUNNING']);

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

export function RepositoryDetailPage() {
  const { id } = useParams();
  const [repository, setRepository] = useState<Repository | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const loadCloneStatus = useCallback(async () => {
    if (!id) return;
    try {
      setCloneStatus(await fetchCloneStatus(id));
    } catch {
      // No clone job exists yet (404) — leave cloneStatus as null, rendered as "Not cloned".
      setCloneStatus(null);
    }
  }, [id]);

  const loadIndexStatus = useCallback(async () => {
    if (!id) return;
    try {
      const status = await fetchIndexStatus(id);
      setIndexStatus(status);
      if (status.status === 'COMPLETED') {
        setIndexSummary(await fetchIndexSummary(id).catch(() => null));
      } else {
        setIndexSummary(null);
      }
    } catch {
      // No index job exists yet (404) — leave indexStatus as null.
      setIndexStatus(null);
      setIndexSummary(null);
    }
  }, [id]);

  const loadEmbedStatus = useCallback(async () => {
    if (!id) return;
    try {
      setEmbedStatus(await fetchEmbedStatus(id));
    } catch {
      // No embedding job exists yet (404) — leave embedStatus as null.
      setEmbedStatus(null);
    }
  }, [id]);

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

  const handleSearch = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!id || searching) return;
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchError('Enter a search query.');
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const response = await searchRepository(id, trimmed);
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

  const handleAsk = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!id || asking) return;
    const trimmed = askQuery.trim();
    if (!trimmed) {
      setAskError('Enter a question.');
      return;
    }
    setAsking(true);
    setAskError(null);
    try {
      const response = await askRepository(id, trimmed);
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

  if (loading) {
    return (
      <div className="dashboard">
        <LoadingSkeleton />
      </div>
    );
  }

  if (error || !repository) {
    return (
      <div className="dashboard">
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

  return (
    <div className="dashboard repository-detail-page">
      <Link to="/repositories" className="back-link">← Back to Repositories</Link>

      <header className="issue-detail-header">
        <span className="category-pill">{PROVIDER_LABEL[repository.provider]}</span>
        <h1>{repository.repoUrl}</h1>
        <div className="detail-tags">
          <a href={repository.repoUrl} target="_blank" rel="noreferrer">{repository.repoUrl}</a>
          <span>Branch: {repository.branch}</span>
        </div>
      </header>

      <div className="repository-meta-grid">
        <div className="repository-meta-item">
          <span className="repository-meta-label">Provider</span>
          <span className="repository-meta-value">{PROVIDER_LABEL[repository.provider]}</span>
        </div>
        <div className="repository-meta-item">
          <span className="repository-meta-label">Repository URL</span>
          <span className="repository-meta-value">{repository.repoUrl}</span>
        </div>
        <div className="repository-meta-item">
          <span className="repository-meta-label">Branch</span>
          <span className="repository-meta-value">{repository.branch}</span>
        </div>
        <div className="repository-meta-item">
          <span className="repository-meta-label">Status</span>
          <span className="repository-meta-value">
            <span className={`activity-status-dot ${repository.status.toLowerCase()}`} aria-hidden="true" />{' '}
            {STATUS_LABEL[repository.status]}
          </span>
        </div>
        <div className="repository-meta-item">
          <span className="repository-meta-label">Created</span>
          <span className="repository-meta-value">{formatDateTime(repository.createdAt)}</span>
        </div>
        <div className="repository-meta-item">
          <span className="repository-meta-label">Updated</span>
          <span className="repository-meta-value">{formatDateTime(repository.updatedAt)}</span>
        </div>
      </div>

      <section className="repository-clone-section">
        <div className="repository-clone-header">
          <div>
            <span className="section-title">Repository Clone</span>
            <p className="repository-clone-state">
              {cloneStatus ? CLONE_STATUS_LABEL[cloneStatus.status] : 'Not cloned'}
            </p>
          </div>
          <div className="repository-clone-actions">
            {cloneInProgress ? (
              <button type="button" className="ghost-button" onClick={handleCancelClone} disabled={cancelling}>
                {cancelling ? 'Cancelling…' : 'Cancel Clone'}
              </button>
            ) : (
              <button type="button" className="primary-button" onClick={handleStartClone} disabled={starting}>
                {starting ? 'Starting…' : cloneStatus ? 'Clone Again' : 'Clone Repository'}
              </button>
            )}
          </div>
        </div>

        {cloneActionError && <p className="connect-repo-error" role="alert">{cloneActionError}</p>}

        {cloneInProgress && (
          <div className="repository-clone-progress">
            <div className="spinner-inline" aria-hidden="true" />
            <p className="muted">
              {cloneStatus?.status === 'QUEUED' ? 'Waiting for a worker to pick up this clone…' : 'Cloning and inspecting the repository…'}
            </p>
          </div>
        )}

        {cloneStatus?.status === 'FAILED' && (
          <HealthBanner variant="error" role="alert">{cloneStatus.error ?? 'Clone failed.'}</HealthBanner>
        )}

        {cloneStatus?.status === 'TIMED_OUT' && (
          <HealthBanner variant="error" role="alert">{cloneStatus.error ?? 'Clone timed out.'}</HealthBanner>
        )}

        {cloneStatus?.status === 'CANCELLED' && (
          <HealthBanner variant="warning">Clone cancelled.</HealthBanner>
        )}

        {cloneReady && (
          <div className="repository-discovery">
            {!indexReady && <HealthBanner variant="ok">Repository ready for indexing.</HealthBanner>}

            <div className="repository-meta-grid">
              <div className="repository-meta-item">
                <span className="repository-meta-label">Commit</span>
                <span className="repository-meta-value repository-commit-sha">{cloneStatus.commitSha}</span>
              </div>
              <div className="repository-meta-item">
                <span className="repository-meta-label">Files</span>
                <span className="repository-meta-value">{cloneStatus.fileCount}</span>
              </div>
              <div className="repository-meta-item">
                <span className="repository-meta-label">Directories</span>
                <span className="repository-meta-value">{cloneStatus.directoryCount}</span>
              </div>
              <div className="repository-meta-item">
                <span className="repository-meta-label">Repository size</span>
                <span className="repository-meta-value">{formatBytes(cloneStatus.totalSizeBytes ?? 0)}</span>
              </div>
            </div>

            {(cloneStatus.topLevelDirectories?.length || cloneStatus.topLevelFiles?.length) ? (
              <div className="repository-top-level">
                <span className="repository-meta-label">Top-level structure</span>
                <ul className="repository-top-level-list">
                  {cloneStatus.topLevelDirectories?.map((dir) => (
                    <li key={`dir-${dir}`}>{dir}/</li>
                  ))}
                  {cloneStatus.topLevelFiles?.map((file) => (
                    <li key={`file-${file}`}>{file}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </section>

      {cloneReady && (
        <section className="repository-clone-section">
          <div className="repository-clone-header">
            <div>
              <span className="section-title">Repository Index</span>
              <p className="repository-clone-state">
                {indexStatus ? INDEX_STATUS_LABEL[indexStatus.status] : 'Not indexed'}
              </p>
            </div>
            <div className="repository-clone-actions">
              {indexInProgress ? (
                <button type="button" className="ghost-button" onClick={handleCancelIndex} disabled={cancellingIndex}>
                  {cancellingIndex ? 'Cancelling…' : 'Cancel Indexing'}
                </button>
              ) : (
                <button type="button" className="primary-button" onClick={handleStartIndex} disabled={startingIndex}>
                  {startingIndex ? 'Starting…' : indexStatus ? 'Index Again' : 'Index Repository'}
                </button>
              )}
            </div>
          </div>

          {indexActionError && <p className="connect-repo-error" role="alert">{indexActionError}</p>}

          {indexInProgress && (
            <div className="repository-clone-progress">
              <div className="spinner-inline" aria-hidden="true" />
              <p className="muted">
                {indexStatus?.status === 'QUEUED' ? 'Waiting for a worker to pick up indexing…' : 'Parsing source files and building the code index…'}
              </p>
            </div>
          )}

          {indexStatus?.status === 'FAILED' && (
            <HealthBanner variant="error" role="alert">{indexStatus.error ?? 'Indexing failed.'}</HealthBanner>
          )}

          {indexStatus?.status === 'CANCELLED' && (
            <HealthBanner variant="warning">Indexing cancelled.</HealthBanner>
          )}

          {indexReady && (
            <div className="repository-discovery">
              <HealthBanner variant="ok">Repository indexed successfully — ready for search.</HealthBanner>
              <div className="repository-meta-grid">
                <div className="repository-meta-item">
                  <span className="repository-meta-label">Commit</span>
                  <span className="repository-meta-value repository-commit-sha">{indexStatus.commitSha}</span>
                </div>
                <div className="repository-meta-item">
                  <span className="repository-meta-label">Files Indexed</span>
                  <span className="repository-meta-value">{indexStatus.filesIndexed}</span>
                </div>
                <div className="repository-meta-item">
                  <span className="repository-meta-label">Files Skipped</span>
                  <span className="repository-meta-value">{indexStatus.filesSkipped}</span>
                </div>
                <div className="repository-meta-item">
                  <span className="repository-meta-label">Code Chunks</span>
                  <span className="repository-meta-value">{indexStatus.chunksCreated}</span>
                </div>
              </div>

              {indexSummary && Object.keys(indexSummary.languages).length > 0 && (
                <div className="repository-top-level">
                  <span className="repository-meta-label">Languages</span>
                  <ul className="repository-top-level-list">
                    {Object.entries(indexSummary.languages)
                      .sort(([, a], [, b]) => b - a)
                      .map(([language, count]) => (
                        <li key={language}>{LANGUAGE_LABEL[language] ?? language}: {count}</li>
                      ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {indexReady && (
        <section className="repository-clone-section">
          <div className="repository-clone-header">
            <div>
              <span className="section-title">Repository Embeddings</span>
              <p className="repository-clone-state">
                {embedStatus ? EMBED_STATUS_LABEL[embedStatus.status] : 'Not embedded'}
              </p>
            </div>
            <div className="repository-clone-actions">
              {embedInProgress ? (
                <button type="button" className="ghost-button" onClick={handleCancelEmbed} disabled={cancellingEmbed}>
                  {cancellingEmbed ? 'Cancelling…' : 'Cancel Embedding'}
                </button>
              ) : (
                <button type="button" className="primary-button" onClick={handleStartEmbed} disabled={startingEmbed}>
                  {startingEmbed ? 'Starting…' : embedStatus ? 'Generate Embeddings Again' : 'Generate Embeddings'}
                </button>
              )}
            </div>
          </div>

          {embedActionError && <p className="connect-repo-error" role="alert">{embedActionError}</p>}

          {embedInProgress && (
            <div className="repository-clone-progress">
              <div className="spinner-inline" aria-hidden="true" />
              <p className="muted">
                {embedStatus?.status === 'QUEUED' ? 'Waiting for a worker to pick up embedding…' : 'Generating BGE-M3 embeddings for each code chunk…'}
              </p>
            </div>
          )}

          {embedStatus?.status === 'FAILED' && (
            <HealthBanner variant="error" role="alert">{embedStatus.error ?? 'Embedding failed.'}</HealthBanner>
          )}

          {embedStatus?.status === 'CANCELLED' && (
            <HealthBanner variant="warning">Embedding cancelled.</HealthBanner>
          )}

          {embedReady && (
            <div className="repository-discovery">
              <HealthBanner variant="ok">Embeddings ready.</HealthBanner>
              <div className="repository-meta-grid">
                <div className="repository-meta-item">
                  <span className="repository-meta-label">Commit</span>
                  <span className="repository-meta-value repository-commit-sha">{embedStatus.commitSha}</span>
                </div>
                <div className="repository-meta-item">
                  <span className="repository-meta-label">Embedding Model</span>
                  <span className="repository-meta-value">{embedStatus.model}</span>
                </div>
                <div className="repository-meta-item">
                  <span className="repository-meta-label">Dimensions</span>
                  <span className="repository-meta-value">{embedStatus.dimensions ?? '—'}</span>
                </div>
                <div className="repository-meta-item">
                  <span className="repository-meta-label">Chunks</span>
                  <span className="repository-meta-value">{embedStatus.embeddedChunks} / {embedStatus.totalChunks}</span>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {indexReady && (
        <section className="repository-clone-section repository-search-section">
          <div className="repository-clone-header">
            <div>
              <span className="section-title">Repository Search</span>
              <p className="repository-clone-state">{embedReady ? 'Semantic code search' : 'Embeddings required'}</p>
            </div>
          </div>

          {!embedReady && (
            <HealthBanner variant="info">Generate embeddings for this repository (above) before you can search its code.</HealthBanner>
          )}

          {embedReady && (
            <>
              <form className="repository-search-form" onSubmit={handleSearch}>
                <input
                  type="text"
                  className="search-input"
                  placeholder="Search this repository's code, e.g. “where is authentication handled?”"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="Repository search query"
                />
                <button type="submit" className="primary-button" disabled={searching}>
                  {searching ? 'Searching…' : 'Search'}
                </button>
              </form>

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
                    <HealthBanner variant="warning">
                      The reranking model is unavailable right now — showing vector-similarity results only (not reranked).
                    </HealthBanner>
                  )}

                  {searchResponse.results.length === 0 ? (
                    <p className="muted">No matching code found for “{searchResponse.query}”.</p>
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
                          <div className="repository-search-result-path repository-commit-sha">
                            {result.filePath}:{result.startLine}-{result.endLine}
                          </div>
                          {result.content && (
                            <pre className="repository-search-result-content"><code>{result.content}</code></pre>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {indexReady && (
        <section className="repository-clone-section repository-ask-section">
          <div className="repository-clone-header">
            <div>
              <span className="section-title">Repository Assistant</span>
              <p className="repository-clone-state">{embedReady ? 'Grounded code Q&A' : 'Embeddings required'}</p>
            </div>
          </div>

          {!embedReady && (
            <HealthBanner variant="info">Generate embeddings for this repository (above) before you can ask questions about its code.</HealthBanner>
          )}

          {embedReady && (
            <>
              <form className="repository-search-form" onSubmit={handleAsk}>
                <input
                  type="text"
                  className="search-input"
                  placeholder="Ask something about this repository, e.g. “How is the health score calculated?”"
                  value={askQuery}
                  onChange={(e) => setAskQuery(e.target.value)}
                  aria-label="Repository assistant question"
                />
                <button type="submit" className="primary-button" disabled={asking}>
                  {asking ? 'Asking…' : 'Ask'}
                </button>
              </form>

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
                    <HealthBanner variant="warning">
                      The reranking model is unavailable right now — this answer is based on vector-similarity results only (not reranked).
                    </HealthBanner>
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
                            <div className="repository-search-result-path repository-commit-sha">
                              {source.filePath}:{source.startLine}-{source.endLine}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {indexReady && (
        <section className="repository-clone-section repository-issues-section">
          <div className="repository-clone-header">
            <div>
              <span className="section-title">Repository Issues</span>
              <p className="repository-clone-state">{issues.length} issue{issues.length === 1 ? '' : 's'}</p>
            </div>
            <div className="repository-clone-actions">
              <button type="button" className="primary-button" onClick={() => setShowCreateIssueForm((v) => !v)}>
                {showCreateIssueForm ? 'Cancel' : 'Report Issue'}
              </button>
            </div>
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
            <p className="muted">No issues reported yet.</p>
          ) : (
            <ul className="repository-issue-list">
              {issues.map((issue) => (
                <li key={issue.id} className="repository-issue-item">
                  <Link to={`/repositories/${id}/issues/${issue.id}`} className="repository-issue-link">
                    <span className={`badge ${issue.severity.toLowerCase()}`}>{issue.severity}</span>
                    <span className="repository-issue-title">{issue.title}</span>
                    <span className="repository-issue-status">{issue.status}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!indexReady && (
        <HealthBanner variant="info">
          Repository analysis is not available yet. Indexing, code search, and AI-powered analysis for connected
          repositories are coming in a future phase.
        </HealthBanner>
      )}
    </div>
  );
}
