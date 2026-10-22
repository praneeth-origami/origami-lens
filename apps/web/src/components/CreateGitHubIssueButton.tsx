import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GitHubIssueLink, Repository, RepositoryProvider } from '@origami/contracts';
import {
  ApiRequestError,
  createGitHubIssue,
  createRepository,
  fetchGitHubIssuePreview,
  fetchRepositoryPrStrategy,
  githubPushConnectUrl,
  REPOSITORY_ROLE_LABEL,
} from '../api/client';
import { lensEvent } from '../notifications/lens-event';
import { GitHubIcon, GitLabIcon, BitbucketIcon } from './icons';

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const PROVIDER_LABEL: Record<RepositoryProvider, string> = { GITHUB: 'GitHub', GITLAB: 'GitLab', BITBUCKET: 'Bitbucket' };
const PROVIDER_ICON: Record<RepositoryProvider, typeof GitHubIcon> = { GITHUB: GitHubIcon, GITLAB: GitLabIcon, BITBUCKET: BitbucketIcon };

/** Same as RepositoriesListPage.tsx's own repoName — duplicated locally, matching this codebase's existing convention for small single-purpose display helpers (see IssueFixWithAi.tsx's identical copy). */
function repoName(repoUrl: string): string {
  try {
    return new URL(repoUrl).pathname.replace(/^\//, '');
  } catch {
    return repoUrl;
  }
}

/** What the OAuth connect/callback pair (index.ts's /providers/github/*) reports back via ?githubConnectError= when returnTo is used — see redirectOauthError's doc comment server-side. */
const GITHUB_CONNECT_ERROR_MESSAGES: Record<string, string> = {
  OAUTH_STATE_MISMATCH: 'GitHub authorization expired before it completed — please try connecting again.',
  OAUTH_EXCHANGE_FAILED: 'GitHub authorization was denied or could not be completed.',
  OAUTH_INVALID_RESPONSE: 'GitHub did not return the information needed to finish connecting.',
  AUTH_NOT_CONFIGURED: 'GitHub authorization is not available right now.',
};

type ModalStep =
  | 'select-repo'
  | 'connect-repo'
  | 'checking-access'
  | 'github-auth-required'
  | 'repo-access-required'
  | 'confirm'
  | 'creating'
  | 'success'
  | 'error';

interface Props {
  issueId: string;
  /** Bugfix (duplicate GitHub issues): every GitHub Issue already filed for this finding, persisted server-side (migration 040) — never only resettable React state, so a page reload/reopen shows the same "already exists" view this modal shows live. */
  githubIssueLinks?: GitHubIssueLink[];
  repositories: Repository[];
  selectedRepoId: string;
  setSelectedRepoId: (id: string) => void;
  reloadRepositories: () => void;
  onLinked: (link: GitHubIssueLink) => void;
}

const RESUME_PARAM = 'resumeGithubIssueModal';
const REPO_PARAM = 'githubIssueRepositoryId';
const ERROR_PARAM = 'githubConnectError';

/**
 * "Create GitHub Issue" — DISTINCT from Fix with AI / Create Pull Request:
 * this never creates a branch, commit, or PR, only a plain GitHub issue.
 * Reuses the SAME repository selection IssueFixWithAi already manages on
 * this page (selectedRepoId/resolution are lifted state, shared with it —
 * never a second, duplicated repo picker) and the SAME GitHub authorization
 * (githubPushConnectUrl), repository-connection (createRepository) and
 * permission-check (fetchRepositoryPrStrategy) logic every other repository
 * feature already uses.
 *
 * Lives in the header's top action row (IssueHeader.tsx), not at the bottom
 * of the page — its content renders as a modal (the SAME overlay/dialog
 * pattern ReportShareModal.tsx uses: createPortal to document.body, focus
 * trap, Escape-to-close, focus restored on close) so opening it never
 * changes the header's height or shifts the rest of the page.
 *
 * Previously this button was simply DISABLED whenever no repository was
 * selected, forcing the user to the Repositories page first. It now opens
 * an in-context setup flow instead — select a repository, resolve GitHub
 * authorization/access, confirm, create — entirely from this modal, per a
 * step indicator (Repository → Access → Create). "Connect GitHub" uses a
 * real `returnTo` (see githubConnectUrl's doc comment + index.ts's OAuth
 * routes) so authorizing GitHub brings the user back to THIS modal, open
 * at the right step, instead of the dashboard root.
 */
export function CreateGitHubIssueButton({ issueId, githubIssueLinks, repositories, selectedRepoId, setSelectedRepoId, reloadRepositories, onLinked }: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ModalStep>('select-repo');
  const [search, setSearch] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [accessOwnerRepo, setAccessOwnerRepo] = useState('');

  /** Bugfix (duplicate GitHub issues): server-persisted truth for "does this repository already have a GitHub Issue for this finding" — always consulted before showing Create, never only local state. */
  const findExistingLink = (repositoryId: string): GitHubIssueLink | undefined =>
    githubIssueLinks?.find((l) => l.repositoryId === repositoryId && l.provider === 'GITHUB');

  /** The single link shown directly on the trigger button, without opening the modal — unambiguous when there's exactly one (the common case); with links in more than one repository, the trigger instead opens the modal, where every repository's own status is visible in the list. */
  const soleExistingLink = githubIssueLinks?.length === 1 ? githubIssueLinks[0] : undefined;

  const [connectFormOpen, setConnectFormOpen] = useState(false);
  const [connectRepoUrl, setConnectRepoUrl] = useState('');
  const [connectBranch, setConnectBranch] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState('');
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ issueNumber: number; issueUrl: string; owner: string; repo: string; alreadyExisted: boolean } | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Focus trap + Escape-to-close + focus restore — identical to ReportShareModal's own modal behavior.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previouslyFocusedRef.current?.focus();
    };
  }, [open]);

  /**
   * Checks (best-effort) whether the repository is reachable at all, then
   * loads the real create-github-issue preview — the SAME authoritative,
   * already-existing call that used to be the only thing openDialog did.
   * Its error code decides which setup step (if any) to show, instead of a
   * flat error string. `repoHint` is passed by handleConnectRepository
   * right after creating a brand-new repository — the `repositories` PROP
   * array hasn't re-fetched yet at that point, so falling back to it alone
   * would briefly show a blank "owner/repo" line.
   */
  const checkAccessAndLoadPreview = async (repositoryId: string, repoHint?: Repository) => {
    setErrorMessage('');
    const repoDisplayName = () => {
      const repo = repoHint ?? repositories.find((r) => r.id === repositoryId);
      return repo ? repoName(repo.repoUrl) : '';
    };

    // Bugfix (duplicate GitHub issues): a repository already linked for this
    // finding is shown immediately from the server-persisted link — no
    // preview fetch, no "Create Issue" affordance ever shown for it again.
    const existing = findExistingLink(repositoryId);
    if (existing) {
      setResult({ issueNumber: existing.issueNumber, issueUrl: existing.issueUrl, owner: existing.githubOwner, repo: existing.githubRepository, alreadyExisted: true });
      setAccessOwnerRepo(`${existing.githubOwner}/${existing.githubRepository}`);
      setStep('success');
      return;
    }

    setStep('checking-access');

    // Best-effort, role-gated signal (OWNER/ADMIN only server-side) — a 403
    // here for a MEMBER just means this pre-check isn't available to them;
    // the authoritative check below still runs either way.
    try {
      const strategy = await fetchRepositoryPrStrategy(repositoryId, { silent: true });
      if (strategy.strategy === 'ADMIN_APPROVAL_REQUIRED') {
        setAccessOwnerRepo(repoDisplayName());
        setStep('github-auth-required');
        return;
      }
    } catch {
      // Not authoritative — fall through to the real preview check below.
    }

    try {
      const preview = await fetchGitHubIssuePreview(issueId, repositoryId, { silent: true });
      setTitle(preview.title);
      setBody(preview.body);
      setLabels(preview.labels.join(', '));
      setAccessOwnerRepo(`${preview.owner}/${preview.repo}`);
      setStep('confirm');
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : undefined;
      const message = err instanceof ApiRequestError ? err.message : 'Could not check repository access.';
      setAccessOwnerRepo(repoDisplayName());
      if (code === 'GITHUB_AUTH_NOT_CONFIGURED') {
        setStep('github-auth-required');
      } else if (code === 'GITHUB_PERMISSION_DENIED') {
        setStep('repo-access-required');
      } else if (code === 'REPOSITORY_NOT_FOUND' || code === 'REPOSITORY_ACCESS_DENIED') {
        setErrorMessage('That repository is no longer accessible — choose a different one.');
        setStep('select-repo');
      } else {
        setErrorMessage(message);
        setStep('error');
      }
    }
  };

  // Resuming after a GitHub authorization redirect — see githubConnectUrl's
  // doc comment. Runs once on mount; cleans its own query params afterward
  // so a refresh/back navigation never re-triggers it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has(RESUME_PARAM)) return;

    const repositoryId = params.get(REPO_PARAM);
    const connectErrorCode = params.get(ERROR_PARAM);

    const url = new URL(window.location.href);
    url.searchParams.delete(RESUME_PARAM);
    url.searchParams.delete(REPO_PARAM);
    url.searchParams.delete(ERROR_PARAM);
    window.history.replaceState({}, '', url.toString());

    setOpen(true);
    if (connectErrorCode) {
      setErrorMessage(GITHUB_CONNECT_ERROR_MESSAGES[connectErrorCode] ?? 'GitHub authorization failed.');
      setStep('error');
      return;
    }
    if (repositoryId) {
      setSelectedRepoId(repositoryId);
      void checkAccessAndLoadPreview(repositoryId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openModal = () => {
    setErrorMessage('');
    setResult(null);
    setSearch('');
    setConnectFormOpen(false);
    setConnectError('');
    setOpen(true);

    if (selectedRepoId) {
      void checkAccessAndLoadPreview(selectedRepoId);
    } else {
      setStep('select-repo');
    }
  };

  const closeModal = () => setOpen(false);

  const handlePickRepository = (repositoryId: string, repoHint?: Repository) => {
    setSelectedRepoId(repositoryId);
    void checkAccessAndLoadPreview(repositoryId, repoHint);
  };

  const handleConnectGitHub = () => {
    const returnTo = `${window.location.pathname}?${RESUME_PARAM}=1&${REPO_PARAM}=${encodeURIComponent(selectedRepoId)}`;
    window.location.href = githubPushConnectUrl(returnTo);
  };

  const handleConnectRepository = async (e: React.FormEvent) => {
    e.preventDefault();
    if (connecting) return;
    setConnectError('');
    setConnecting(true);
    try {
      const created = await createRepository({ repoUrl: connectRepoUrl.trim(), branch: connectBranch.trim() || undefined, role: 'FULL_STACK' });
      reloadRepositories();
      lensEvent.success('Repository connected', { resource: repoName(created.repoUrl) });
      setConnectFormOpen(false);
      setConnectRepoUrl('');
      setConnectBranch('');
      handlePickRepository(created.id, created);
    } catch (err) {
      setConnectError(err instanceof ApiRequestError ? err.message : 'Could not connect this repository.');
    } finally {
      setConnecting(false);
    }
  };

  const confirmCreate = async () => {
    setCreating(true);
    setErrorMessage('');
    try {
      const response = await createGitHubIssue(issueId, selectedRepoId, {
        title,
        body,
        labels: labels.split(',').map((l) => l.trim()).filter(Boolean),
      }, { silent: true });
      const [owner, repo] = accessOwnerRepo.split('/');
      const alreadyExisted = response.alreadyExisted ?? false;
      setResult({ ...response, owner: owner ?? '', repo: repo ?? accessOwnerRepo, alreadyExisted });
      if (!alreadyExisted) {
        lensEvent.success('GitHub issue created', { resource: `#${response.issueNumber}` });
      }
      onLinked({
        repositoryId: selectedRepoId,
        provider: 'GITHUB',
        githubOwner: owner ?? '',
        githubRepository: repo ?? accessOwnerRepo,
        issueNumber: response.issueNumber,
        issueUrl: response.issueUrl,
        createdAt: new Date().toISOString(),
      });
      setStep('success');
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : undefined;
      const message = err instanceof ApiRequestError ? err.message : 'Could not create the GitHub issue.';
      if (code === 'GITHUB_AUTH_NOT_CONFIGURED') setStep('github-auth-required');
      else if (code === 'GITHUB_PERMISSION_DENIED') setStep('repo-access-required');
      else {
        setErrorMessage(message);
        setStep('error');
      }
    } finally {
      setCreating(false);
    }
  };

  const filteredRepositories = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return repositories;
    return repositories.filter((repo) => {
      const name = repoName(repo.repoUrl).toLowerCase();
      return name.includes(q) || PROVIDER_LABEL[repo.provider].toLowerCase().includes(q) || repo.branch.toLowerCase().includes(q);
    });
  }, [repositories, search]);

  const stepIndex = (): number => {
    if (step === 'select-repo' || step === 'connect-repo') return 0;
    if (step === 'checking-access' || step === 'github-auth-required' || step === 'repo-access-required') return 1;
    return 2; // confirm, creating, success, error
  };

  return (
    <>
      {soleExistingLink ? (
        <span className="github-issue-trigger-group">
          <a
            className="ghost-button github-issue-trigger"
            href={soleExistingLink.issueUrl}
            target="_blank"
            rel="noreferrer"
          >
            <GitHubIcon /> View GitHub Issue #{soleExistingLink.issueNumber} ↗
          </a>
          {repositories.length > 1 && (
            <button
              type="button"
              className="ghost-button github-issue-trigger-more"
              title="File this finding in another repository"
              aria-label="File this finding in another repository"
              onClick={openModal}
            >
              +
            </button>
          )}
        </span>
      ) : (
        <button type="button" className="ghost-button github-issue-trigger" onClick={openModal}>
          <GitHubIcon /> Create GitHub Issue
        </button>
      )}

      {open && createPortal(
        <div className="report-share-overlay" onClick={closeModal}>
          <div
            ref={dialogRef}
            className="report-share-dialog github-issue-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="github-issue-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="report-share-header">
              <h2 id="github-issue-dialog-title">Create GitHub Issue</h2>
              <button type="button" ref={closeButtonRef} className="report-share-close" onClick={closeModal} aria-label="Close">✕</button>
            </div>

            <ol className="persona-steps github-issue-steps" aria-label="Create GitHub Issue progress">
              {['Repository', 'Access', 'Create'].map((label, i) => (
                <li key={label} className={`persona-step ${i === stepIndex() ? 'active' : ''}`}>
                  <span className="persona-step-index" aria-hidden="true">{i + 1}</span>
                  <span className="persona-step-label">{label}</span>
                  {i < 2 && <span className="persona-step-connector" aria-hidden="true" />}
                </li>
              ))}
            </ol>

            {step === 'select-repo' && (
              <div className="github-issue-step">
                <p className="page-subtitle">Choose where this issue should be created.</p>
                {errorMessage && <p className="connect-repo-error" role="alert">{errorMessage}</p>}

                {repositories.length === 0 ? (
                  <p className="muted">No repositories are connected yet.</p>
                ) : (
                  <>
                    {repositories.length > 5 && (
                      <input
                        type="text"
                        className="search-input"
                        placeholder="Search repositories…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        aria-label="Search repositories"
                      />
                    )}
                    <div className="github-issue-repo-list" role="radiogroup" aria-label="Select a repository">
                      {filteredRepositories.map((repo) => {
                        const Icon = PROVIDER_ICON[repo.provider];
                        const existingLink = findExistingLink(repo.id);
                        return (
                          <label key={repo.id} className={`github-issue-repo-row ${selectedRepoId === repo.id ? 'selected' : ''}`}>
                            <input
                              type="radio"
                              name="github-issue-repo"
                              checked={selectedRepoId === repo.id}
                              onChange={() => setSelectedRepoId(repo.id)}
                            />
                            <span className="github-issue-repo-icon" aria-hidden="true"><Icon /></span>
                            <span className="github-issue-repo-body">
                              <span className="github-issue-repo-name">{repoName(repo.repoUrl)}</span>
                              <span className="github-issue-repo-meta">{PROVIDER_LABEL[repo.provider]} · {repo.branch} · {REPOSITORY_ROLE_LABEL[repo.role]}</span>
                            </span>
                            {existingLink && <span className="github-issue-repo-linked-badge">✓ Issue #{existingLink.issueNumber}</span>}
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}

                {!connectFormOpen ? (
                  <button type="button" className="ghost-button github-issue-connect-new" onClick={() => setConnectFormOpen(true)}>
                    + Connect a repository
                  </button>
                ) : (
                  <form className="connect-repo-form github-issue-connect-form" onSubmit={(e) => void handleConnectRepository(e)}>
                    <div className="connect-repo-field">
                      <label htmlFor="gh-issue-repo-url">Repository URL</label>
                      <input
                        id="gh-issue-repo-url"
                        type="text"
                        className="search-input"
                        placeholder="https://github.com/facebook/react"
                        value={connectRepoUrl}
                        onChange={(e) => setConnectRepoUrl(e.target.value)}
                        required
                      />
                    </div>
                    <div className="connect-repo-field">
                      <label htmlFor="gh-issue-repo-branch">Branch</label>
                      <input
                        id="gh-issue-repo-branch"
                        type="text"
                        className="search-input"
                        placeholder="main"
                        value={connectBranch}
                        onChange={(e) => setConnectBranch(e.target.value)}
                      />
                    </div>
                    {connectError && <p className="connect-repo-error" role="alert">{connectError}</p>}
                    <div className="confirm-dialog-actions">
                      <button type="button" className="ghost-button" onClick={() => setConnectFormOpen(false)} disabled={connecting}>Cancel</button>
                      <button type="submit" className="primary-button" disabled={connecting || !connectRepoUrl.trim()}>
                        {connecting ? 'Connecting…' : 'Connect'}
                      </button>
                    </div>
                  </form>
                )}

                <div className="confirm-dialog-actions">
                  <button type="button" className="ghost-button" onClick={closeModal}>Cancel</button>
                  <button type="button" className="primary-button" disabled={!selectedRepoId} onClick={() => handlePickRepository(selectedRepoId)}>
                    Continue
                  </button>
                </div>
              </div>
            )}

            {step === 'checking-access' && (
              <div className="github-issue-step">
                <p className="page-subtitle">Checking repository access…</p>
              </div>
            )}

            {(step === 'github-auth-required' || step === 'repo-access-required') && (
              <div className="github-issue-step">
                <h3>{step === 'github-auth-required' ? 'GitHub authorization required' : 'Repository access required'}</h3>
                <p className="muted">
                  {step === 'github-auth-required'
                    ? 'Origami Lens needs permission to create an issue in:'
                    : "You don't currently have the required access to:"}
                </p>
                <p className="repository-commit-sha">{accessOwnerRepo}</p>
                <div className="confirm-dialog-actions">
                  <button type="button" className="ghost-button" onClick={closeModal}>Cancel</button>
                  <button type="button" className="ghost-button" onClick={() => setStep('select-repo')}>Change Repository</button>
                  <button type="button" className="primary-button" onClick={handleConnectGitHub}>
                    <GitHubIcon /> Connect GitHub
                  </button>
                </div>
              </div>
            )}

            {step === 'confirm' && (
              <div className="github-issue-step">
                <p className="page-subtitle">
                  Repository: <strong>{accessOwnerRepo}</strong>{' '}
                  <button type="button" className="github-issue-change-repo" onClick={() => setStep('select-repo')}>Change</button>
                </p>
                <label className="github-issue-field">
                  Title
                  <input value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label className="github-issue-field">
                  Description
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} />
                </label>
                <label className="github-issue-field">
                  Labels (comma-separated)
                  <input value={labels} onChange={(e) => setLabels(e.target.value)} />
                </label>
                <div className="confirm-dialog-actions">
                  <button type="button" className="ghost-button" onClick={closeModal} disabled={creating}>Cancel</button>
                  <button type="button" className="primary-button" onClick={() => void confirmCreate()} disabled={creating || !title.trim()}>
                    {creating ? 'Creating…' : 'Create Issue'}
                  </button>
                </div>
              </div>
            )}

            {step === 'success' && result && (
              <div className="github-issue-step">
                <h3>{result.alreadyExisted ? 'GitHub Issue Already Exists ✓' : 'GitHub Issue Created ✓'}</h3>
                <p className="muted">{accessOwnerRepo}</p>
                <p className="ai-response">#{result.issueNumber}</p>
                <div className="confirm-dialog-actions">
                  <button type="button" className="ghost-button" onClick={closeModal}>Done</button>
                  <a className="primary-button" href={result.issueUrl} target="_blank" rel="noreferrer">
                    View GitHub Issue ↗
                  </a>
                </div>
              </div>
            )}

            {step === 'error' && (
              <div className="github-issue-step">
                <p className="connect-repo-error" role="alert">{errorMessage}</p>
                <div className="confirm-dialog-actions">
                  <button type="button" className="ghost-button" onClick={closeModal}>Cancel</button>
                  <button type="button" className="ghost-button" onClick={() => setStep('select-repo')}>Change Repository</button>
                  <button type="button" className="primary-button" onClick={() => selectedRepoId && void checkAccessAndLoadPreview(selectedRepoId)}>
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
