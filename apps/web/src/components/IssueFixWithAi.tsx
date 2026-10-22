import type {
  Repository,
  RepositoryFixApproveResponse,
  RepositoryFixGroundingDiagnostic,
  RepositoryFixProposalResponse,
  RepositoryFixRevisionMismatchDiagnostic,
  RepositoryFixReviewResponse,
  RepositoryFixSyntaxErrorDetail,
  RepositoryPrStrategyPreviewResponse,
  RepositoryResolution,
} from '@origami/contracts';
import { githubPushConnectUrl, REPOSITORY_ROLE_LABEL } from '../api/client';
import { CodeBracketIcon } from './icons';
import { PrStrategyBadge } from './PrStrategyBadge';

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
  /** Set only when aiFixError's failure was PROPOSAL_UNGROUNDED or SOURCE_REVISION_MISMATCH — hashes/metadata only (never raw source). */
  aiFixDiagnostic: RepositoryFixGroundingDiagnostic | RepositoryFixRevisionMismatchDiagnostic | null;
  aiFixProposal: RepositoryFixProposalResponse | null;
  aiFixDecision: 'approved' | 'rejected' | null;
  onProposeAiFix: () => void;
  onApproveProposal: () => void;
  onRejectProposal: () => void;
  reviewLoading: boolean;
  reviewError: string | null;
  /** Set only when reviewError's failure was SYNTAX_VALIDATION_FAILED — the real parser's file/line/column/message. */
  reviewSyntaxError: RepositoryFixSyntaxErrorDetail | null;
  reviewResponse: RepositoryFixReviewResponse | null;
  confirmingPr: boolean;
  setConfirmingPr: (value: boolean) => void;
  prLoading: boolean;
  prError: string | null;
  /** True only when approval failed with the ADMIN_APPROVAL_REQUIRED error code — rendered as an explanatory state (with a connect link), not a generic error. */
  prAdminApprovalRequired: boolean;
  prResult: RepositoryFixApproveResponse | null;
  /** Read-only preview of which PR method WOULD be used, resolved for the selected repository — null while loading/unavailable (no badge shown). */
  prStrategyPreview: RepositoryPrStrategyPreviewResponse | null;
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
  aiFixDiagnostic,
  aiFixProposal,
  aiFixDecision,
  onProposeAiFix,
  onApproveProposal,
  onRejectProposal,
  reviewLoading,
  reviewError,
  reviewSyntaxError,
  reviewResponse,
  confirmingPr,
  setConfirmingPr,
  prLoading,
  prError,
  prAdminApprovalRequired,
  prResult,
  prStrategyPreview,
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

      {aiFixError && (
        <div>
          <p className="connect-repo-error" role="alert">{aiFixError}</p>
          {aiFixDiagnostic && (
            <div className="fix-validation-error" role="alert">
              <p className="detail-action-message">
                {'hunkIndex' in aiFixDiagnostic ? 'Proposal rejected — ungrounded' : 'Proposal rejected — revision mismatch'}
              </p>
              {'hunkIndex' in aiFixDiagnostic ? (
                <>
                  <div className="repository-ask-answer">
                    <span className="repository-meta-label">File</span>
                    <p className="repository-commit-sha">{aiFixDiagnostic.filePath}</p>
                  </div>
                  <div className="repository-ask-answer">
                    <span className="repository-meta-label">Commit</span>
                    <p className="repository-commit-sha">{aiFixDiagnostic.commitSha}</p>
                  </div>
                  <div className="repository-ask-answer">
                    <span className="repository-meta-label">Hunk</span>
                    <p>{aiFixDiagnostic.hunkIndex + 1} (reported lines {aiFixDiagnostic.reportedStartLine}-{aiFixDiagnostic.reportedEndLine})</p>
                  </div>
                  <div className="repository-ask-answer">
                    <span className="repository-meta-label">oldText hash</span>
                    <p className="repository-commit-sha">{aiFixDiagnostic.oldTextHash}</p>
                  </div>
                  <div className="repository-ask-answer">
                    <span className="repository-meta-label">Indexed content hash</span>
                    <p className="repository-commit-sha">{aiFixDiagnostic.indexedContentHash}</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="repository-ask-answer">
                    <span className="repository-meta-label">File</span>
                    <p className="repository-commit-sha">{aiFixDiagnostic.filePath ?? '(unknown)'}</p>
                  </div>
                  <div className="repository-ask-answer">
                    <span className="repository-meta-label">Expected commit</span>
                    <p className="repository-commit-sha">{aiFixDiagnostic.expectedCommitSha}</p>
                  </div>
                  <div className="repository-ask-answer">
                    <span className="repository-meta-label">Indexed commit</span>
                    <p className="repository-commit-sha">{aiFixDiagnostic.indexedCommitSha}</p>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

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

              {aiFixProposal.sourceGrounding && (
                <div className={`fix-source-grounding fix-source-grounding-${aiFixProposal.sourceGrounding.confidence.toLowerCase()}`}>
                  <div className="fix-source-grounding-header">
                    <span className="repository-meta-label">Source match confidence</span>
                    <span className={`badge fix-confidence-badge fix-confidence-${aiFixProposal.sourceGrounding.confidence.toLowerCase()}`}>
                      {aiFixProposal.sourceGrounding.confidence === 'LOW' && '⚠ '}
                      {aiFixProposal.sourceGrounding.confidence.charAt(0) + aiFixProposal.sourceGrounding.confidence.slice(1).toLowerCase()}
                    </span>
                  </div>
                  {aiFixProposal.sourceGrounding.matchedEvidence.length > 0 && (
                    <p className="fix-source-grounding-evidence">
                      Evidence matched:{' '}
                      {aiFixProposal.sourceGrounding.matchedEvidence.map((token) => (
                        <span key={token} className="fix-evidence-chip">✓ {token}</span>
                      ))}
                    </p>
                  )}
                  {aiFixProposal.sourceGrounding.note && (
                    <p className="muted fix-source-grounding-note">
                      {aiFixProposal.sourceGrounding.confidence === 'LOW' ? 'Origami Lens found a possible source file, but could not strongly associate it with the scanned DOM element. ' : ''}
                      {aiFixProposal.sourceGrounding.note}
                    </p>
                  )}
                </div>
              )}

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
                reviewSyntaxError ? (
                  <div className="fix-validation-error" role="alert">
                    <p className="detail-action-message">Fix validation failed</p>
                    <div className="repository-ask-answer">
                      <span className="repository-meta-label">File</span>
                      <p className="repository-commit-sha">{reviewSyntaxError.filePath}</p>
                    </div>
                    <div className="repository-ask-answer">
                      <span className="repository-meta-label">Validation</span>
                      <p>{reviewSyntaxError.validationType}</p>
                    </div>
                    <div className="repository-ask-answer">
                      <span className="repository-meta-label">Line</span>
                      <p>{reviewSyntaxError.line}, Column {reviewSyntaxError.column}</p>
                    </div>
                    <div className="repository-ask-answer">
                      <span className="repository-meta-label">Error</span>
                      <p>{reviewSyntaxError.message}</p>
                    </div>
                  </div>
                ) : (
                  <p className="connect-repo-error" role="alert">{reviewError}</p>
                )
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
                    <div className="ai-actions pr-strategy-actions-row">
                      {prStrategyPreview && <PrStrategyBadge strategy={prStrategyPreview.strategy} />}
                      <button type="button" className="primary-button" onClick={() => setConfirmingPr(true)}>Create Pull Request</button>
                    </div>
                  )}

                  {confirmingPr && (
                    <div className="repository-discovery">
                      {prStrategyPreview && (
                        <p className="muted">
                          <PrStrategyBadge strategy={prStrategyPreview.strategy} /> — {prStrategyPreview.detail}
                        </p>
                      )}
                      <p>Create a branch, commit the reviewed changes, push it to the repository, and open a Pull Request?</p>
                      <div className="ai-actions">
                        <button type="button" className="ghost-button" onClick={() => setConfirmingPr(false)}>Cancel</button>
                        <button type="button" className="primary-button" onClick={onCreatePr} disabled={prStrategyPreview?.strategy === 'ADMIN_APPROVAL_REQUIRED'}>Create Pull Request</button>
                      </div>
                    </div>
                  )}

                  {prLoading && (
                    <div className="repository-clone-progress">
                      <div className="spinner-inline" aria-hidden="true" />
                      <p className="muted">Creating branch, committing, pushing, and opening a pull request…</p>
                    </div>
                  )}

                  {prError && prAdminApprovalRequired ? (
                    <div className="repository-discovery admin-approval-required-notice">
                      <p className="detail-action-message"><PrStrategyBadge strategy="ADMIN_APPROVAL_REQUIRED" /></p>
                      <p className="muted">{prError}</p>
                      <div className="ai-actions">
                        <a className="primary-button" href={githubPushConnectUrl()}>Connect GitHub for direct access</a>
                      </div>
                    </div>
                  ) : (
                    prError && <p className="connect-repo-error" role="alert">{prError}</p>
                  )}

                  {prResult && (
                    <div className="repository-discovery">
                      <p className="detail-action-message">{prRequestLabel(prResult.provider)} created</p>
                      {prResult.prStrategy && (
                        <div className="repository-ask-answer">
                          <span className="repository-meta-label">Method</span>
                          <p><PrStrategyBadge strategy={prResult.prStrategy} /></p>
                        </div>
                      )}
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
