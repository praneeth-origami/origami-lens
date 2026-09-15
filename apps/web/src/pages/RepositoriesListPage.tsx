import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Repository } from '@origami/contracts';
import { createRepository, fetchRepositories } from '../api/client';
import { LoadingSkeleton, ErrorState } from '../components/StateViews';
import { ProviderConnections } from '../components/ProviderConnections';

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

export function RepositoriesListPage() {
  const navigate = useNavigate();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchRepositories()
      .then((data) => setRepositories(data.repositories))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load repositories'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);
    setSubmitting(true);
    try {
      const created = await createRepository({
        repoUrl: repoUrl.trim(),
        branch: branch.trim() || undefined,
      });
      setShowForm(false);
      setRepoUrl('');
      setBranch('');
      load();
      navigate(`/repositories/${created.id}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to connect repository');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="list-page animate-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">Repositories</h1>
          <p className="page-subtitle">Connect public repositories to prepare them for repository analysis.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : '+ Connect Repository'}
        </button>
      </div>

      <ProviderConnections />

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
          {formError && <p className="connect-repo-error" role="alert">{formError}</p>}
          <div className="connect-repo-actions">
            <button type="submit" className="primary-button" disabled={submitting}>
              {submitting ? 'Connecting…' : 'Connect Repository'}
            </button>
          </div>
        </form>
      )}

      {loading && <LoadingSkeleton />}
      {!loading && error && <ErrorState message={error} onRetry={load} />}

      {!loading && !error && repositories.length === 0 && (
        <div className="empty-state">
          <p>No repositories connected yet. Connect a public GitHub, GitLab, or Bitbucket repository to get started.</p>
        </div>
      )}

      {!loading && !error && repositories.length > 0 && (
        <div className="record-table-wrap">
          <table className="record-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>Provider</th>
                <th>Branch</th>
                <th>Status</th>
                <th>Created</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {repositories.map((repo) => (
                <tr
                  key={repo.id}
                  onClick={() => navigate(`/repositories/${repo.id}`)}
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/repositories/${repo.id}`); }}
                >
                  <td>
                    <span className="record-primary">{repoName(repo.repoUrl)}</span>
                    <span className="record-secondary">{repo.repoUrl}</span>
                  </td>
                  <td>{PROVIDER_LABEL[repo.provider]}</td>
                  <td>{repo.branch}</td>
                  <td>
                    <span className={`activity-status-dot ${repo.status.toLowerCase()}`} aria-hidden="true" />{' '}
                    {STATUS_LABEL[repo.status]}
                  </td>
                  <td>{formatDate(repo.createdAt)}</td>
                  <td>{formatDate(repo.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
