import type {
  Repository,
  RepositoryFixApproveResponse,
  RepositoryFixProposalResponse,
  RepositoryFixReviewResponse,
  RepositoryResolution,
} from '@origami/contracts';
import { REPOSITORY_ROLE_LABEL } from '../api/client';
import { CodeBracketIcon } from './icons';

/** Phase 13 — GitLab calls the same concept a "Merge Request"; every other supported provider (GitHub, Bitbucket) calls it a "Pull Request". Purely a display-label choice — the underlying generic RepositoryFixApproveResponse is unchanged. */
function prRequestLabel(provider: string): string {
  return provider === 'GITLAB' ? 'Merge Request' : 'Pull Request';
}

/** Same as RepositoriesListPage.tsx's own repoName — duplicated locally rather than shared, matching this codebase's existing convention for small single-purpose display helpers. */
function repoName(repoUrl: string): string {
  try {
    return new URL(repoUrl).pathname.replace(/^\//, '');
  } catch {
    return repoUrl;
  }
}

interface Props {
  repositories: Repository[];
  selectedRepoId: string;
  setSelectedRepoId: (id: string) => void;
  resolution: RepositoryResolution | null;
  aiFixInstruction: string;
  setAiFixInstruction: (value: string) => void;
  aiFixLoading: boolean;
  aiFixError: string | null;
  aiFixProposal: RepositoryFixProposalResponse | null;
  aiFixDecision: 'approved' | 'rejected' | null;
  onProposeAiFix: () => void;
  onApproveProposal: () => void;
  onRejectProposal: () => void;
  reviewLoading: boolean;
  reviewError: string | null;
  reviewResponse: RepositoryFixReviewResponse | null;
  confirmingPr: boolean;
  setConfirmingPr: (value: boolean) => void;
  prLoading: boolean;
  prError: string | null;
  prResult: RepositoryFixApproveResponse | null;
  onCreatePr: () => void;
}

/**
 * "Fix with AI" card — identical repository-fix workflow the page already
 * ran (propose → review → approve → create PR/MR), just pulled out of
 * IssueDetailPage's render method into its own component. No handler here
 * does anything the page's existing handleProposeAiFix/handleApproveProposal/
 * handleCreatePr didn't already do — this component is presentation only.
 */
export function IssueFixWithAi({
  repositories,
  selectedRepoId,
  setSelectedRepoId,
  resolution,
  aiFixInstruction,
  setAiFixInstruction,
  aiFixLoading,
  aiFixError,
  aiFixProposal,
  aiFixDecision,
  onProposeAiFix,
  onApproveProposal,
  onRejectProposal,
  reviewLoading,
  reviewError,
  reviewResponse,
  confirmingPr,
  setConfirmingPr,
  prLoading,
  prError,
  prResult,
  onCreatePr,
}: Props) {
  return (
    <section className="ai-section repository-ask-section issue-fix-with-ai">
      <div className="ai-section-heading">
        <div className="ai-section-icon"><CodeBracketIcon /></div>
        <div>
          <h3>Fix with AI</h3>
          <p className="muted">Analyze this issue against your connected repository and get a reviewable code change.</p>
        </div>
      </div>

      {resolution?.status === 'resolved' ? (
        <p className="muted repository-resolved-line">
          Repository: <strong>{repoName(resolution.repository.repoUrl)}</strong> ({REPOSITORY_ROLE_LABEL[resolution.repository.role]})
        </p>
      ) : (
        <div className="ask-row">
          <select className="search-input" value={selectedRepoId} onChange={(e) => setSelectedRepoId(e.target.value)} aria-label="Repository to fix against">
            <option value="">Select a repository…</option>
            {(resolution?.status === 'unresolved' ? resolution.candidates : repositories).map((repo) => (
              <option key={repo.id} value={repo.id}>{repoName(repo.repoUrl)} ({REPOSITORY_ROLE_LABEL[repo.role]})</option>
            ))}
          </select>
        </div>
      )}
      <div className="ask-row">
        <input
          type="text"
          className="search-input"
          placeholder="Optional instruction (e.g. &quot;Fix only the accessibility issue, don't change the layout.&quot;)"
          value={aiFixInstruction}
          onChange={(e) => setAiFixInstruction(e.target.value)}
          aria-label="Optional instruction for the AI"
        />
        <button type="button" className="primary-button" onClick={onProposeAiFix} disabled={aiFixLoading || !selectedRepoId}>
          {aiFixLoading ? 'Analyzing…' : 'Fix with AI'}
        </button>
      </div>

      <p className="muted fix-with-ai-note">
        This creates a review-only change. No code is written to your repository until you review and approve.
      </p>

      {resolution?.status !== 'resolved' && !selectedRepoId && repositories.length > 0 && <p className="muted">Choose a connected repository above first.</p>}
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
                  <button type="button" className="primary-button" onClick={onApproveProposal}>Approve</button>
                  <button type="button" className="ghost-button" onClick={onRejectProposal}>Reject</button>
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
                        <button type="button" className="primary-button" onClick={onCreatePr}>Create Pull Request</button>
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
    </section>
  );
}
