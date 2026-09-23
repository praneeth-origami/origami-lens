import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  AggregatedIssue,
  Issue,
  IssueStatus,
  Repository,
  RepositoryFixApproveResponse,
  RepositoryFixProposalResponse,
  RepositoryFixReviewResponse,
} from '@origami/contracts';
import {
  approveRepositoryFindingFix,
  ApiRequestError,
  askAi,
  CATEGORY_LABEL,
  fetchIssue,
  fetchRepositories,
  fetchScan,
  proposeRepositoryFindingFix,
  reviewRepositoryFindingFix,
  SEVERITY_LABEL,
  STATUS_LABEL,
  suggestFix,
  updateIssueStatus,
} from '../api/client';
import { IssueEvidence } from '../components/IssueEvidence';
import { ErrorState, LoadingSkeleton } from '../components/StateViews';
import { ScreenshotViewer } from '../components/ScreenshotViewer';

/** Phase 13 — GitLab calls the same concept a "Merge Request"; every other supported provider (GitHub, Bitbucket) calls it a "Pull Request". Purely a display-label choice — the underlying generic RepositoryFixApproveResponse is unchanged. */
function prRequestLabel(provider: string): string {
  return provider === 'GITLAB' ? 'Merge Request' : 'Pull Request';
}

export function IssueDetailPage() {
  const { issueId } = useParams();
  const [issue, setIssue] = useState<Issue | AggregatedIssue | null>(null);
  const [scanMeta, setScanMeta] = useState<{ scanId: string; url: string; scannedAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [askInput, setAskInput] = useState('Why is this happening?');
  const [askResponse, setAskResponse] = useState('');
  const [fixResponse, setFixResponse] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [scanArtifacts, setScanArtifacts] = useState<
    Awaited<ReturnType<typeof fetchScan>>['artifacts']
  >(undefined);

  // Phase 10 — "Fix with AI": a scan finding has no inherent link to a
  // connected repository, so the user picks which one to check the finding
  // against.
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [aiFixInstruction, setAiFixInstruction] = useState('');
  const [aiFixLoading, setAiFixLoading] = useState(false);
  const [aiFixError, setAiFixError] = useState<string | null>(null);
  const [aiFixProposal, setAiFixProposal] = useState<RepositoryFixProposalResponse | null>(null);
  const [aiFixDecision, setAiFixDecision] = useState<'approved' | 'rejected' | null>(null);

  // Phase 11/12 — reviewing and (only after explicit confirmation) turning
  // an approved proposal into a real branch/commit/PR. Generating or even
  // reviewing a fix never pushes anything on its own — only handleCreatePr,
  // fired from the explicit confirmation dialog below, ever does that.
  const [reviewResponse, setReviewResponse] = useState<RepositoryFixReviewResponse | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [confirmingPr, setConfirmingPr] = useState(false);
  const [prLoading, setPrLoading] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [prResult, setPrResult] = useState<RepositoryFixApproveResponse | null>(null);

  useEffect(() => {
    if (!issueId) return;
    setLoading(true);
    fetchIssue(issueId)
      .then(async (data) => {
        setIssue(data.issue);
        setScanMeta(data.scan);
        try {
          const scan = await fetchScan(data.scan.scanId);
          setScanArtifacts(scan.artifacts);
        } catch {
          // Screenshots optional if scan metadata unavailable
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Issue not found'))
      .finally(() => setLoading(false));
  }, [issueId]);

  useEffect(() => {
    fetchRepositories()
      .then((res) => setRepositories(res.repositories))
      .catch(() => setRepositories([]));
  }, []);

  const handleStatusChange = async (status: IssueStatus) => {
    if (!issue) return;
    const updated = await updateIssueStatus(issue.id, status);
    setIssue(updated.issue);
  };

  const handleAsk = async () => {
    if (!issue || !scanMeta) return;
    setAiLoading(true);
    setAskResponse('');
    try {
      const res = await askAi(askInput, issue, scanMeta.url);
      setAskResponse(res.answer + (res.aiAvailable ? '' : ' (Deterministic fallback — AI unavailable)'));
    } catch {
      setAskResponse('AI explanation unavailable.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleSuggestFix = async () => {
    if (!issue || !scanMeta) return;
    setAiLoading(true);
    setFixResponse('');
    try {
      const res = await suggestFix(issue, scanMeta.url);
      const fix = res.fix as { fix?: string; explanation?: string };
      setFixResponse(
        fix.fix || fix.explanation || JSON.stringify(res.fix, null, 2) ||
          (res.aiAvailable ? '' : 'AI unavailable — see deterministic suggested fix above.'),
      );
    } catch {
      setFixResponse('Suggested fix unavailable.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleProposeAiFix = async () => {
    if (!issue || !selectedRepoId || aiFixLoading) return;
    setAiFixLoading(true);
    setAiFixError(null);
    setAiFixProposal(null);
    setAiFixDecision(null);
    setReviewResponse(null);
    setReviewError(null);
    setConfirmingPr(false);
    setPrResult(null);
    setPrError(null);
    try {
      const proposal = await proposeRepositoryFindingFix(selectedRepoId, issue.id, aiFixInstruction.trim() || undefined);
      setAiFixProposal(proposal);
    } catch (err) {
      setAiFixError(err instanceof Error ? err.message : 'Failed to generate a fix proposal');
    } finally {
      setAiFixLoading(false);
    }
  };

  const handleApproveProposal = async () => {
    if (!issue || !selectedRepoId || !aiFixProposal || aiFixProposal.status !== 'PROPOSED') return;
    setAiFixDecision('approved');
    setReviewLoading(true);
    setReviewError(null);
    setReviewResponse(null);
    setPrResult(null);
    setPrError(null);
    try {
      const review = await reviewRepositoryFindingFix(selectedRepoId, issue.id, aiFixProposal);
      setReviewResponse(review);
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Failed to prepare the fix for review');
    } finally {
      setReviewLoading(false);
    }
  };

  const handleCreatePr = async () => {
    if (!issue || !selectedRepoId || !aiFixProposal || !reviewResponse || prLoading) return;
    setConfirmingPr(false);
    setPrLoading(true);
    setPrError(null);
    try {
      const result = await approveRepositoryFindingFix(selectedRepoId, issue.id, reviewResponse.applicationId, aiFixProposal);
      setPrResult(result);
    } catch (err) {
      setPrError(err instanceof ApiRequestError ? err.message : err instanceof Error ? err.message : 'Failed to create the pull request');
    } finally {
      setPrLoading(false);
    }
  };

  const handleShareIssue = async () => {
    if (!issue || !scanMeta) return;

    const shareUrl = `${window.location.origin}${window.location.pathname}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: issue.title,
          text: `${issue.title} — ${scanMeta.url}`,
          url: shareUrl,
        });
        setActionMessage('Issue shared successfully.');
        return;
      }

      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(shareUrl);
        setActionMessage('Issue link copied to clipboard.');
        return;
      }

      setActionMessage('Sharing is not available in this browser.');
    } catch {
      setActionMessage('Share cancelled or unavailable.');
    }
  };

  const handleExportIssue = () => {
    if (!issue || !scanMeta) return;

    const payload = {
      scanId: scanMeta.scanId,
      issueId: issue.id,
      url: scanMeta.url,
      title: issue.title,
      severity: issue.severity,
      category: issue.category,
      status: issue.status ?? 'open',
      source: issue.source,
      problem: issue.problem,
      cause: issue.cause,
      impact: issue.impact,
      suggestedFix: issue.suggestedFix,
      evidence: issue.evidence,
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `issue-${issue.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);

    setActionMessage('Issue exported as JSON.');
  };

  if (loading) {
    return (
      <div className="dashboard">
        <LoadingSkeleton />
      </div>
    );
  }

  if (error || !issue || !scanMeta) {
    return (
      <div className="dashboard">
        <ErrorState message={error ?? 'Issue not found'} />
        <Link to="/" className="">← Back to Dashboard</Link>
      </div>
    );
  }

  const severityClass = issue.severity.toLowerCase();

  return (
    <div className="dashboard issue-detail-page">
      <div className="issue-detail-topbar">
        <Link to={`/scans/${scanMeta.scanId}`} className="primary-button">← Back to Dashboard</Link>

        <div className="issue-detail-actions">
          <button type="button" className="ghost-button" onClick={handleShareIssue}>Share</button>
          <button type="button" className="primary-button" onClick={handleExportIssue}>Export</button>
        </div>
      </div>

      <header className="issue-detail-header">
        <span className={`severity-badge ${severityClass}`}>{SEVERITY_LABEL[issue.severity]}</span>
        <h1>{issue.title}</h1>
        <div className="detail-tags">
          <span>{CATEGORY_LABEL[issue.category]}</span>
          <span>{STATUS_LABEL[issue.status ?? 'open']}</span>
          <a href={scanMeta.url} target="_blank" rel="noreferrer">{scanMeta.url}</a>
        </div>
      </header>

      <div className="detail-grid">
        <section>
          <h3>Problem</h3>
          <p>{issue.problem}</p>
        </section>
        <section>
          <h3>Cause</h3>
          <p>{issue.cause}</p>
        </section>
        <section>
          <h3>Impact</h3>
          <p>{issue.impact}</p>
        </section>
        <section>
          <h3>Suggested Fix</h3>
          <p>{issue.suggestedFix}</p>
        </section>
      </div>

      <IssueEvidence issue={issue} />

      {'occurrences' in issue && issue.occurrences.length > 0 && (
        <section className="occurrences-section">
          <h3>Affected Pages ({issue.affectedPages.length})</h3>
          <ul className="occurrences-list">
            {issue.occurrences.map((occ, idx) => (
              <li key={`${occ.pageScanId}-${idx}`}>
                <a href={occ.url} target="_blank" rel="noreferrer">{occ.url}</a>
                <details>
                  <summary>Evidence</summary>
                  <pre>{JSON.stringify(occ.evidence, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(issue.category === 'visualMobile' || issue.source === 'vision-ai') && scanMeta && (
        <ScreenshotViewer scanId={scanMeta.scanId} artifacts={scanArtifacts} />
      )}

      <div className="status-control">
        <label htmlFor="status-select">Status</label>
        <select
          id="status-select"
          value={issue.status ?? 'open'}
          onChange={(e) => handleStatusChange(e.target.value as IssueStatus)}
        >
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      <div className="ai-section">
        <h3>Ask AI</h3>
        <div className="ask-row">
          <input value={askInput} onChange={(e) => setAskInput(e.target.value)} />
          <button type="button" className="ghost-button" onClick={handleAsk} disabled={aiLoading}>Ask AI</button>
        </div>
        {askResponse && <p className="ai-response">{askResponse}</p>}

        <div className="ai-actions">
          <button type="button" className="primary-button" onClick={handleSuggestFix} disabled={aiLoading}>
            Suggested Fix (AI)
          </button>
        </div>
        {fixResponse && <pre className="ai-response">{fixResponse}</pre>}
        {actionMessage && <p className="detail-action-message">{actionMessage}</p>}
      </div>

      <div className="ai-section repository-ask-section">
        <h3>Fix with AI</h3>
        <p className="muted">
          Analyzes this finding against a connected, indexed repository and proposes a reviewable code change.
          This is review-only — nothing is written to the repository, and no branch, commit, or pull request is created.
        </p>

        <div className="ask-row">
          <select className="search-input" value={selectedRepoId} onChange={(e) => setSelectedRepoId(e.target.value)} aria-label="Repository to fix against">
            <option value="">Select a repository…</option>
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>{repo.repoUrl}</option>
            ))}
          </select>
        </div>
        <div className="ask-row">
          <input
            type="text"
            className="search-input"
            placeholder="Optional instruction, e.g. “Fix only the accessibility issue, don't change the layout.”"
            value={aiFixInstruction}
            onChange={(e) => setAiFixInstruction(e.target.value)}
            aria-label="Optional instruction for the AI"
          />
          <button type="button" className="primary-button" onClick={handleProposeAiFix} disabled={aiFixLoading || !selectedRepoId}>
            {aiFixLoading ? 'Analyzing…' : 'Fix with AI'}
          </button>
        </div>
        {!selectedRepoId && repositories.length > 0 && <p className="muted">Choose a connected repository above first.</p>}
        {repositories.length === 0 && <p className="muted">No connected repositories — connect one from the Repositories page first.</p>}

        {aiFixError && <p className="connect-repo-error" role="alert">{aiFixError}</p>}

        {aiFixLoading && (
          <div className="repository-clone-progress">
            <div className="spinner-inline" aria-hidden="true" />
            <p className="muted">Retrieving relevant code and generating a proposal…</p>
          </div>
        )}

        {!aiFixLoading && aiFixProposal && (
          <div className="repository-discovery">
            {aiFixProposal.reranked === false && (
              <p className="muted">The reranking model was unavailable — this proposal is based on vector-similarity results only.</p>
            )}

            {aiFixProposal.status === 'INSUFFICIENT_EVIDENCE' ? (
              <p className="ai-response">{aiFixProposal.summary}</p>
            ) : (
              <>
                <div className="repository-ask-answer">
                  <span className="repository-meta-label">Summary</span>
                  <p>{aiFixProposal.summary}</p>
                </div>
                <div className="repository-ask-answer">
                  <span className="repository-meta-label">Reasoning</span>
                  <p>{aiFixProposal.reasoning}</p>
                </div>

                <div className="repository-ask-sources">
                  <span className="repository-meta-label">Files Changed</span>
                  {aiFixProposal.changes.map((change) => (
                    <div key={change.filePath} className="repository-search-result">
                      <div className="repository-search-result-header">
                        <span className="repository-search-result-symbol">{change.filePath}</span>
                        <span className="badge">{change.language}</span>
                      </div>
                      {change.hunks.map((hunk, i) => (
                        <pre key={i} className="repository-fix-diff">
                          <div className="repository-commit-sha">Lines {hunk.startLine}-{hunk.endLine}</div>
                          <div className="repository-fix-diff-line-remove">- {hunk.oldText}</div>
                          <div className="repository-fix-diff-line-add">+ {hunk.newText}</div>
                        </pre>
                      ))}
                    </div>
                  ))}
                </div>

                {aiFixProposal.sources.length > 0 && (
                  <div className="repository-ask-sources">
                    <span className="repository-meta-label">Sources</span>
                    <ul className="repository-search-results">
                      {aiFixProposal.sources.map((source, i) => (
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

                {aiFixDecision === null ? (
                  <div className="ai-actions">
                    <button type="button" className="primary-button" onClick={handleApproveProposal}>Approve</button>
                    <button type="button" className="ghost-button" onClick={() => setAiFixDecision('rejected')}>Reject</button>
                  </div>
                ) : aiFixDecision === 'rejected' ? (
                  <p className="detail-action-message">Proposal rejected.</p>
                ) : reviewLoading ? (
                  <div className="repository-clone-progress">
                    <div className="spinner-inline" aria-hidden="true" />
                    <p className="muted">Applying the change to an isolated copy of the repository…</p>
                  </div>
                ) : reviewError ? (
                  <p className="connect-repo-error" role="alert">{reviewError}</p>
                ) : reviewResponse ? (
                  <div className="repository-discovery">
                    <p className="detail-action-message">Fix ready for review</p>

                    <div className="repository-ask-sources">
                      <span className="repository-meta-label">Changed files</span>
                      <ul className="repository-search-results">
                        {reviewResponse.changedFiles.map((f) => (
                          <li key={f.filePath} className="repository-search-result">
                            <div className="repository-search-result-header">
                              <span className="repository-search-result-symbol">{f.filePath}</span>
                              <span className="badge">+{f.additions}/-{f.deletions}</span>
                            </div>
                            <div className="repository-commit-sha">Syntax: {f.syntaxStatus}</div>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {reviewResponse.lineGrounding.length > 0 && (
                      <div className="repository-ask-sources">
                        <span className="repository-meta-label">Line grounding</span>
                        <ul className="repository-search-results">
                          {reviewResponse.lineGrounding.map((g, i) => (
                            <li key={`${g.filePath}-${i}`} className="repository-search-result repository-commit-sha">
                              {g.filePath}: reported line {g.reportedStartLine} → actual line {g.actualStartLine}
                              {g.matchedExactly ? '' : ' (AI-reported line number was inaccurate — the real file content was used instead)'}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="repository-ask-sources">
                      <span className="repository-meta-label">Diff</span>
                      <pre className="repository-fix-diff">{reviewResponse.diff}</pre>
                    </div>

                    {!confirmingPr && !prLoading && !prResult && !prError && (
                      <div className="ai-actions">
                        <button type="button" className="primary-button" onClick={() => setConfirmingPr(true)}>Create Pull Request</button>
                      </div>
                    )}

                    {confirmingPr && (
                      <div className="repository-discovery">
                        <p>Create a branch, commit the reviewed changes, push it to the repository, and open a Pull Request?</p>
                        <div className="ai-actions">
                          <button type="button" className="ghost-button" onClick={() => setConfirmingPr(false)}>Cancel</button>
                          <button type="button" className="primary-button" onClick={handleCreatePr}>Create Pull Request</button>
                        </div>
                      </div>
                    )}

                    {prLoading && (
                      <div className="repository-clone-progress">
                        <div className="spinner-inline" aria-hidden="true" />
                        <p className="muted">Creating branch, committing, pushing, and opening a pull request…</p>
                      </div>
                    )}

                    {prError && <p className="connect-repo-error" role="alert">{prError}</p>}

                    {prResult && (
                      <div className="repository-discovery">
                        <p className="detail-action-message">{prRequestLabel(prResult.provider)} created</p>
                        <div className="repository-ask-answer">
                          <span className="repository-meta-label">Branch</span>
                          <p className="repository-commit-sha">{prResult.branchName}</p>
                        </div>
                        <div className="repository-ask-answer">
                          <span className="repository-meta-label">Commit</span>
                          <p className="repository-commit-sha">{prResult.commitSha}</p>
                        </div>
                        {prResult.prNumber !== undefined && (
                          <div className="repository-ask-answer">
                            <span className="repository-meta-label">{prRequestLabel(prResult.provider)}</span>
                            <p>
                              #{prResult.prNumber}
                              {prResult.prUrl && (
                                <>
                                  {' — '}
                                  <a href={prResult.prUrl} target="_blank" rel="noreferrer">{prResult.prUrl}</a>
                                </>
                              )}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
