import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { Repository, RepositoryRole, RepositoryStatus } from '@origami/contracts';
import { createRepository, deleteRepository, fetchRepositories, REPOSITORY_ROLE_LABEL } from '../api/client';
import { ErrorState } from '../components/StateViews';
import { ProviderConnections } from '../components/ProviderConnections';
import {
  CodeBracketIcon,
  DatabaseIcon,
  GitBranchIcon,
  GitHubIcon,
  GitLabIcon,
  BitbucketIcon,
  MoreIcon,
  CheckIcon,
  CheckCircleIcon,
  ClockIcon,
  AlertTriangleIcon,
  SparkleIcon,
} from '../components/icons';
import { lensEvent } from '../notifications/lens-event';
import { confirm } from '../notifications/confirm';

const REPOSITORY_ROLES: RepositoryRole[] = ['FULL_STACK', 'FRONTEND', 'BACKEND'];

const PROVIDER_LABEL: Record<Repository['provider'], string> = {
  GITHUB: 'GitHub',
  GITLAB: 'GitLab',
  BITBUCKET: 'Bitbucket',
};

const PROVIDER_ICON: Record<Repository['provider'], typeof GitHubIcon> = {
  GITHUB: GitHubIcon,
  GITLAB: GitLabIcon,
  BITBUCKET: BitbucketIcon,
};

/** Visual tone per status, following the redesign's legend: ready=green, processing=blue, pending=amber (awaiting the next explicit trigger), failed=red, inactive=gray. Labels are unchanged from the page's existing, already-accurate copy. */
const STATUS_META: Record<RepositoryStatus, { label: string; tone: 'ready' | 'processing' | 'pending' | 'failed' | 'inactive' }> = {
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

const PROCESSING_STATUSES = new Set<RepositoryStatus>(['CLONING', 'INDEXING', 'EMBEDDING']);

function repoName(repoUrl: string): string {
  try {
    return new URL(repoUrl).pathname.replace(/^\//, '');
  } catch {
    return repoUrl;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

interface ActionItem {
  label: string;
  onClick: () => void;
  destructive?: boolean;
}

/** Generic portal-based "•••" menu, same pattern as WorkspaceMembersPage.tsx's ActionsMenu — this page's rows also sit inside `.animate-in`, which traps position:fixed descendants unless portaled to document.body. */
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
        className="repo-actions-trigger"
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

export function RepositoriesListPage() {
  const navigate = useNavigate();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [role, setRole] = useState<RepositoryRole>('FULL_STACK');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = () => {
    setLoading(true);
    setError(null);
    fetchRepositories()
      .then((data) => setRepositories(data.repositories))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load repositories'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const summary = useMemo(() => {
    let ready = 0;
    let indexing = 0;
    let failed = 0;
    for (const repo of repositories) {
      if (repo.status === 'EMBEDDINGS_READY') ready += 1;
      else if (PROCESSING_STATUSES.has(repo.status)) indexing += 1;
      else if (repo.status === 'FAILED') failed += 1;
    }
    return { total: repositories.length, ready, indexing, failed };
  }, [repositories]);

  const filteredRepositories = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return repositories;
    return repositories.filter((repo) => {
      return (
        repoName(repo.repoUrl).toLowerCase().includes(q) ||
        PROVIDER_LABEL[repo.provider].toLowerCase().includes(q) ||
        repo.branch.toLowerCase().includes(q) ||
        REPOSITORY_ROLE_LABEL[repo.role].toLowerCase().includes(q)
      );
    });
  }, [repositories, search]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);
    setSubmitting(true);
    try {
      const created = await createRepository({
        repoUrl: repoUrl.trim(),
        branch: branch.trim() || undefined,
        role,
      });
      setShowForm(false);
      setRepoUrl('');
      setBranch('');
      setRole('FULL_STACK');
      load();
      lensEvent.success('Repository connected', { resource: repoName(created.repoUrl), icon: <CodeBracketIcon /> });
      navigate(`/repositories/${created.id}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to connect repository');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (repo: Repository) => {
    if (deletingId) return;
    const confirmed = await confirm({
      title: 'Delete repository?',
      description: `Delete ${repoName(repo.repoUrl)}? This also removes its indexing/embedding data and clone workspace. This cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;

    setDeletingId(repo.id);
    try {
      await deleteRepository(repo.id);
      setRepositories((prev) => prev.filter((r) => r.id !== repo.id));
      lensEvent.success('Repository deleted', { resource: repoName(repo.repoUrl) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete repository');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="list-page animate-in">
      <div className="page-heading-row workspace-heading-row">
        <div>
          <div className="page-eyebrow"><DatabaseIcon /> Repositories</div>
          <h1 className="page-title">Code repositories</h1>
          <p className="page-subtitle">Connect and manage your repositories to enable deep code analysis and AI-powered fixes.</p>
        </div>
        <div className="workspace-header-card">
          <span className="workspace-header-card-icon" aria-hidden="true"><DatabaseIcon /></span>
          <div>
            <div className="workspace-header-card-title">CONNECT. ANALYZE. FIX.</div>
            <div className="workspace-header-card-subtitle">Link your repositories and let Origami Lens find and fix issues in your code.</div>
          </div>
        </div>
      </div>

      <ProviderConnections />

      <div className="connect-repo-card">
        <div className="connect-repo-card-header">
          <span className="connect-repo-card-icon" aria-hidden="true"><CodeBracketIcon /></span>
          <div className="connect-repo-card-copy">
            <h2>Add a repository</h2>
            <p>Paste a public repository URL to prepare it for indexing and AI-powered analysis.</p>
          </div>
          <button type="button" className="primary-button" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : '+ Add repository'}
          </button>
        </div>

        {showForm && (
          <form className="connect-repo-form" onSubmit={handleConnect}>
            <div className="connect-repo-field">
              <label htmlFor="repo-url">Repository URL</label>
              <input
                id="repo-url"
                type="text"
                className="search-input"
                placeholder="https://github.com/facebook/react"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                required
              />
            </div>
            <div className="connect-repo-field">
              <label htmlFor="repo-branch">Branch</label>
              <input
                id="repo-branch"
                type="text"
                className="search-input"
                placeholder="main"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </div>
            <div className="connect-repo-field">
              <label htmlFor="repo-role">Role</label>
              <select id="repo-role" className="search-input" value={role} onChange={(e) => setRole(e.target.value as RepositoryRole)}>
                {REPOSITORY_ROLES.map((r) => (
                  <option key={r} value={r}>{REPOSITORY_ROLE_LABEL[r]}</option>
                ))}
              </select>
              <p className="muted">Full Stack for one repository with both frontend and backend code; Frontend/Backend when connecting them separately.</p>
            </div>
            {formError && <p className="connect-repo-error" role="alert">{formError}</p>}
            <div className="connect-repo-actions">
              <button type="submit" className="primary-button" disabled={submitting}>
                {submitting ? 'Connecting…' : 'Connect Repository'}
              </button>
            </div>
          </form>
        )}
      </div>

      {loading && (
        <div className="repo-skeleton-table">
          {[0, 1, 2].map((i) => <div key={i} className="repo-skeleton-row" />)}
        </div>
      )}

      {!loading && error && <ErrorState message={error} onRetry={load} />}

      {!loading && !error && repositories.length === 0 && (
        <div className="empty-state-card">
          <span className="empty-state-icon" aria-hidden="true"><DatabaseIcon /></span>
          <h3>No repositories connected</h3>
          <p>Connect a repository to analyze your code, find issues and generate AI-powered fixes.</p>
          <button type="button" className="primary-button" onClick={() => setShowForm(true)}>
            Connect repository
          </button>
        </div>
      )}

      {!loading && !error && repositories.length > 0 && (
        <>
          <div className="repo-summary-row">
            <div className="repo-summary-grid">
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon total" aria-hidden="true"><DatabaseIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{summary.total}</span>
                  <span className="repo-summary-tile-label">Total repositories</span>
                  <span className="repo-summary-tile-hint">Connected to this workspace</span>
                </div>
              </div>
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon ready" aria-hidden="true"><CheckCircleIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{summary.ready}</span>
                  <span className="repo-summary-tile-label">Ready</span>
                  <span className="repo-summary-tile-hint">Embeddings completed</span>
                </div>
              </div>
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon processing" aria-hidden="true"><ClockIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{summary.indexing}</span>
                  <span className="repo-summary-tile-label">Indexing</span>
                  <span className="repo-summary-tile-hint">Currently processing</span>
                </div>
              </div>
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon failed" aria-hidden="true"><AlertTriangleIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{summary.failed}</span>
                  <span className="repo-summary-tile-label">Failed</span>
                  <span className="repo-summary-tile-hint">Across all repositories</span>
                </div>
              </div>
            </div>

            <div className="list-page-search repo-summary-search">
              <input
                type="text"
                className="search-input"
                placeholder="Search repositories…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search repositories"
              />
            </div>
          </div>

          {filteredRepositories.length === 0 ? (
            <div className="empty-state-card">
              <span className="empty-state-icon" aria-hidden="true"><CodeBracketIcon /></span>
              <h3>No repositories match your search</h3>
              <p>Try a different repository name, provider, branch, or role.</p>
            </div>
          ) : (
            <div className="record-table-wrap">
              <table className="record-table repo-table">
                <thead>
                  <tr>
                    <th>Repository</th>
                    <th>Role</th>
                    <th>Provider</th>
                    <th>Branch</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Updated</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {filteredRepositories.map((repo) => {
                    const ProviderIcon = PROVIDER_ICON[repo.provider];
                    const statusMeta = STATUS_META[repo.status];
                    const items: ActionItem[] = [
                      { label: 'View repository', onClick: () => window.open(repo.repoUrl, '_blank', 'noopener,noreferrer') },
                      { label: 'View details', onClick: () => navigate(`/repositories/${repo.id}`) },
                      { label: 'Delete repository', destructive: true, onClick: () => void handleDelete(repo) },
                    ];
                    return (
                      <tr
                        key={repo.id}
                        onClick={() => navigate(`/repositories/${repo.id}`)}
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) navigate(`/repositories/${repo.id}`); }}
                      >
                        <td data-label="Repository">
                          <div className="repo-identity">
                            <span className="repo-identity-icon" aria-hidden="true"><ProviderIcon /></span>
                            <div>
                              <span className="record-primary">{repoName(repo.repoUrl)}</span>
                              <span className="record-secondary">{repo.repoUrl}</span>
                            </div>
                          </div>
                        </td>
                        <td data-label="Role"><span className={`badge repository-role-${repo.role.toLowerCase()}`}>{REPOSITORY_ROLE_LABEL[repo.role]}</span></td>
                        <td data-label="Provider">
                          <span className="repo-provider-cell"><ProviderIcon /> {PROVIDER_LABEL[repo.provider]}</span>
                        </td>
                        <td data-label="Branch">
                          <span className="repo-branch-cell"><GitBranchIcon /> {repo.branch}</span>
                        </td>
                        <td data-label="Status">
                          <span className={`repo-status-pill ${statusMeta.tone}`}>
                            <span className="repo-status-dot" aria-hidden="true" />
                            {statusMeta.label}
                          </span>
                        </td>
                        <td data-label="Created">{formatDate(repo.createdAt)}</td>
                        <td data-label="Updated">{formatDate(repo.updatedAt)}</td>
                        <td data-label="Actions" className="repo-actions-cell">
                          <RowActionsMenu items={items} ariaLabel={`Actions for ${repoName(repo.repoUrl)}`} busy={deletingId === repo.id} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="repo-getting-started-card">
        <span className="repo-getting-started-icon" aria-hidden="true"><SparkleIcon /></span>
        <div>
          <h3>Getting started with repositories</h3>
          <p>Connect a repository to enable code analysis, issue detection and AI-powered fixes.</p>
          <ul className="repo-getting-started-list">
            <li><CheckIcon /> Code analysis</li>
            <li><CheckIcon /> Issue detection</li>
            <li><CheckIcon /> AI-powered fixes</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
