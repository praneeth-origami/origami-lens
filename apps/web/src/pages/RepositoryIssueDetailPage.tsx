import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { RepositoryFixProposal, RepositoryIssue, RepositoryIssueAnalysis } from '@origami/contracts';
import {
  analyzeRepositoryIssue,
  approveRepositoryFixProposal,
  fetchRepositoryFixProposals,
  fetchRepositoryIssue,
  fetchRepositoryIssueAnalysis,
  proposeRepositoryFix,
  rejectRepositoryFixProposal,
} from '../api/client';
import { HealthBanner } from '../components/HealthBanner';
import { ErrorState, LoadingSkeleton } from '../components/StateViews';

const IN_PROGRESS_ISSUE_STATUSES = new Set(['ANALYZING']);
const IN_PROGRESS_PROPOSAL_STATUSES = new Set(['QUEUED', 'RUNNING']);

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="repository-fix-diff">
      {diff.split('\n').map((line, i) => {
        const cls = line.startsWith('+') && !line.startsWith('+++') ? 'repository-fix-diff-line-add'
          : line.startsWith('-') && !line.startsWith('---') ? 'repository-fix-diff-line-remove'
          : undefined;
        return <div key={i} className={cls}>{line || ' '}</div>;
      })}
    </pre>
  );
}

export function RepositoryIssueDetailPage() {
  const { id, issueId } = useParams();
  const [issue, setIssue] = useState<RepositoryIssue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [analysis, setAnalysis] = useState<RepositoryIssueAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const [proposals, setProposals] = useState<RepositoryFixProposal[]>([]);
  const [proposingFix, setProposingFix] = useState(false);
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decidingProposalId, setDecidingProposalId] = useState<string | null>(null);

  const loadIssue = useCallback(async () => {
    if (!id || !issueId) return;
    try {
      setIssue(await fetchRepositoryIssue(id, issueId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load issue');
    } finally {
      setLoading(false);
    }
  }, [id, issueId]);

  const loadAnalysis = useCallback(async () => {
    if (!id || !issueId) return;
    try {
      setAnalysis(await fetchRepositoryIssueAnalysis(id, issueId));
    } catch {
      // No analysis exists yet (404) — leave analysis as null.
      setAnalysis(null);
    }
  }, [id, issueId]);

  const loadProposals = useCallback(async () => {
    if (!id || !issueId) return;
    try {
      const response = await fetchRepositoryFixProposals(id, issueId);
      setProposals(response.proposals);
    } catch {
      setProposals([]);
    }
  }, [id, issueId]);

  useEffect(() => { loadIssue(); }, [loadIssue]);
  useEffect(() => { loadAnalysis(); loadProposals(); }, [loadAnalysis, loadProposals]);

  // Poll while the issue is ANALYZING or the latest proposal is still being generated.
  useEffect(() => {
    const latestProposal = proposals[0];
    const issueInProgress = issue && IN_PROGRESS_ISSUE_STATUSES.has(issue.status);
    const proposalInProgress = latestProposal && IN_PROGRESS_PROPOSAL_STATUSES.has(latestProposal.status);
    if (!issueInProgress && !proposalInProgress) return;
    const interval = setInterval(() => {
      loadIssue();
      loadAnalysis();
      loadProposals();
    }, 2000);
    return () => clearInterval(interval);
  }, [issue, proposals, loadIssue, loadAnalysis, loadProposals]);

  const handleAnalyze = async () => {
    if (!id || !issueId || analyzing) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      await analyzeRepositoryIssue(id, issueId);
      await loadIssue();
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Failed to start analysis');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleProposeFix = async () => {
    if (!id || !issueId || proposingFix) return;
    setProposingFix(true);
    setProposeError(null);
    try {
      await proposeRepositoryFix(id, issueId);
      await Promise.all([loadIssue(), loadProposals()]);
    } catch (err) {
      setProposeError(err instanceof Error ? err.message : 'Failed to propose a fix');
    } finally {
      setProposingFix(false);
    }
  };

  const handleDecision = async (proposalId: string, decision: 'approve' | 'reject') => {
    if (!id || !issueId || decidingProposalId) return;
    setDecidingProposalId(proposalId);
    setDecisionError(null);
    try {
      if (decision === 'approve') await approveRepositoryFixProposal(id, issueId, proposalId);
      else await rejectRepositoryFixProposal(id, issueId, proposalId);
      await Promise.all([loadIssue(), loadProposals()]);
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : 'Failed to record decision');
    } finally {
      setDecidingProposalId(null);
    }
  };

  if (loading) {
    return (
      <div className="dashboard">
        <LoadingSkeleton />
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="dashboard">
        <ErrorState message={error ?? 'Issue not found'} onRetry={loadIssue} />
        <Link to={`/repositories/${id}`} className="back-link">← Back to Repository</Link>
      </div>
    );
  }

  const issueAnalyzing = IN_PROGRESS_ISSUE_STATUSES.has(issue.status);
  const canAnalyze = issue.status === 'OPEN' || issue.status === 'FAILED';
  const canProposeFix = analysis?.status === 'COMPLETED' && !proposals.some((p) => IN_PROGRESS_PROPOSAL_STATUSES.has(p.status) || p.status === 'FIX_PROPOSED');
  const latestProposal = proposals[0];

  return (
    <div className="dashboard repository-detail-page">
      <Link to={`/repositories/${id}`} className="back-link">← Back to Repository</Link>

      <header className="issue-detail-header">
        <span className={`category-pill badge ${issue.severity.toLowerCase()}`}>{issue.severity}</span>
        <h1>{issue.title}</h1>
        <div className="detail-tags">
          <span>Status: {issue.status}</span>
          <span className="repository-commit-sha">Commit: {issue.commitSha}</span>
        </div>
      </header>

      <div className="repository-meta-grid">
        <div className="repository-meta-item">
          <span className="repository-meta-label">Description</span>
          <span className="repository-meta-value">{issue.description}</span>
        </div>
        {issue.filePath && (
          <div className="repository-meta-item">
            <span className="repository-meta-label">File</span>
            <span className="repository-meta-value repository-commit-sha">{issue.filePath}</span>
          </div>
        )}
        {issue.symbol && (
          <div className="repository-meta-item">
            <span className="repository-meta-label">Symbol</span>
            <span className="repository-meta-value">{issue.symbol}</span>
          </div>
        )}
        {issue.lineStart !== undefined && (
          <div className="repository-meta-item">
            <span className="repository-meta-label">Lines</span>
            <span className="repository-meta-value">{issue.lineStart}-{issue.lineEnd}</span>
          </div>
        )}
      </div>

      <section className="repository-clone-section">
        <div className="repository-clone-header">
          <div>
            <span className="section-title">AI Analysis</span>
            <p className="repository-clone-state">{analysis ? analysis.status : 'Not analyzed yet'}</p>
          </div>
          <div className="repository-clone-actions">
            {canAnalyze && (
              <button type="button" className="primary-button" onClick={handleAnalyze} disabled={analyzing}>
                {analyzing ? 'Starting…' : 'Analyze Issue'}
              </button>
            )}
          </div>
        </div>

        {analyzeError && <p className="connect-repo-error" role="alert">{analyzeError}</p>}

        {issueAnalyzing && (
          <div className="repository-clone-progress">
            <div className="spinner-inline" aria-hidden="true" />
            <p className="muted">Analyzing issue using indexed repository evidence…</p>
          </div>
        )}

        {issue.status === 'FAILED' && !issueAnalyzing && (
          <HealthBanner variant="error" role="alert">Analysis failed. You can try analyzing again.</HealthBanner>
        )}

        {analysis?.status === 'COMPLETED' && (
          <div className="repository-issue-detail-grid">
            <div className="repository-meta-item">
              <span className="repository-meta-label">Confidence</span>
              <span className="repository-meta-value">{analysis.confidence}</span>
            </div>
            <div className="repository-meta-item">
              <span className="repository-meta-label">Summary</span>
              <span className="repository-meta-value">{analysis.summary}</span>
            </div>
            <div className="repository-meta-item">
              <span className="repository-meta-label">Root Cause</span>
              <span className="repository-meta-value">{analysis.rootCause}</span>
            </div>
            <div className="repository-meta-item">
              <span className="repository-meta-label">Reasoning</span>
              <span className="repository-meta-value">{analysis.reasoning}</span>
            </div>
            <div className="repository-meta-item">
              <span className="repository-meta-label">Recommended Fix</span>
              <span className="repository-meta-value">{analysis.recommendedFix}</span>
            </div>
            <div className="repository-meta-item">
              <span className="repository-meta-label">Validation Plan</span>
              <span className="repository-meta-value">{analysis.validationPlan}</span>
            </div>
          </div>
        )}
      </section>

      {analysis?.status === 'COMPLETED' && (
        <section className="repository-clone-section">
          <div className="repository-clone-header">
            <div>
              <span className="section-title">Fix Proposal</span>
              <p className="repository-clone-state">{latestProposal ? latestProposal.status : 'No proposal yet'}</p>
            </div>
            <div className="repository-clone-actions">
              {canProposeFix && (
                <button type="button" className="primary-button" onClick={handleProposeFix} disabled={proposingFix}>
                  {proposingFix ? 'Starting…' : 'Propose Fix'}
                </button>
              )}
            </div>
          </div>

          {proposeError && <p className="connect-repo-error" role="alert">{proposeError}</p>}
          {decisionError && <p className="connect-repo-error" role="alert">{decisionError}</p>}

          {latestProposal && IN_PROGRESS_PROPOSAL_STATUSES.has(latestProposal.status) && (
            <div className="repository-clone-progress">
              <div className="spinner-inline" aria-hidden="true" />
              <p className="muted">Generating a proposed fix…</p>
            </div>
          )}

          {latestProposal?.status === 'FAILED' && (
            <HealthBanner variant="error" role="alert">{latestProposal.validationError ?? 'Fix proposal failed validation.'}</HealthBanner>
          )}

          {latestProposal && (latestProposal.status === 'FIX_PROPOSED' || latestProposal.status === 'APPROVED' || latestProposal.status === 'REJECTED') && (
            <div className="repository-issue-detail-grid">
              <div className="repository-meta-item">
                <span className="repository-meta-label">Summary</span>
                <span className="repository-meta-value">{latestProposal.summary}</span>
              </div>
              <div className="repository-meta-item">
                <span className="repository-meta-label">Affected Files</span>
                <span className="repository-meta-value">{latestProposal.filesChanged.map((f) => `${f.filePath} (${f.changeType})`).join(', ')}</span>
              </div>
              <DiffView diff={latestProposal.proposedDiff} />

              {latestProposal.status === 'FIX_PROPOSED' && (
                <div className="repository-clone-actions">
                  <button type="button" className="primary-button" onClick={() => handleDecision(latestProposal.id, 'approve')} disabled={decidingProposalId === latestProposal.id}>
                    Approve
                  </button>
                  <button type="button" className="ghost-button" onClick={() => handleDecision(latestProposal.id, 'reject')} disabled={decidingProposalId === latestProposal.id}>
                    Reject
                  </button>
                </div>
              )}
              {latestProposal.status === 'APPROVED' && (
                <HealthBanner variant="ok">Approved for the next phase — this review-only approval has not modified the repository.</HealthBanner>
              )}
              {latestProposal.status === 'REJECTED' && <HealthBanner variant="warning">This proposal was rejected.</HealthBanner>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
