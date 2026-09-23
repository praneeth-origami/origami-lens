import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type {
  AggregatedIssue,
  HealthScore,
  Issue,
  IssueStatus,
  Repository,
  RepositoryFixApproveResponse,
  RepositoryFixProposalResponse,
  RepositoryFixReviewResponse,
} from '@origami/contracts';
import type { RepositoryResolution } from '@origami/contracts';
import {
  approveRepositoryFindingFix,
  ApiRequestError,
  askAi,
  fetchIssue,
  fetchRepositories,
  fetchRepositoryResolution,
  fetchScan,
  proposeRepositoryFindingFix,
  reviewRepositoryFindingFix,
  suggestFix,
  updateIssueStatus,
} from '../api/client';
import { ErrorState, LoadingSkeleton } from '../components/StateViews';
import { Disclosure } from '../components/Disclosure';
import { lensEvent } from '../notifications/lens-event';
import { PullRequestIcon } from '../components/icons';
import { IssueHeader } from '../components/IssueHeader';
import { IssueHealthCard } from '../components/IssueHealthCard';
import { IssueInsightCards } from '../components/IssueInsightCards';
import { EvidenceSection } from '../components/EvidenceSection';
import { IssueAskAi } from '../components/IssueAskAi';
import { IssueFixWithAi } from '../components/IssueFixWithAi';
import { IssueSidebar, type RelatedLink } from '../components/IssueSidebar';

interface ScanMeta {
  scanId: string;
  url: string;
  scannedAt: string;
  healthScore?: HealthScore;
}

/** No related-links field exists anywhere in the Issue/AggregatedIssue API response today — kept empty (and the sidebar card hides itself) rather than inventing WCAG/axe/MDN URLs. See IssueSidebar.tsx's RelatedLinksCard. */
const NO_RELATED_LINKS: RelatedLink[] = [];

export function IssueDetailPage() {
  const { issueId } = useParams();
  const [issue, setIssue] = useState<Issue | AggregatedIssue | null>(null);
  const [scanMeta, setScanMeta] = useState<ScanMeta | null>(null);
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
  // against. Migration 019's repository-resolution endpoint skips that pick
  // entirely when there's nothing to actually choose (already chosen, or
  // only one repository connected) — see resolution below.
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [resolution, setResolution] = useState<RepositoryResolution | null>(null);
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

  useEffect(() => {
    if (!issueId) return;
    fetchRepositoryResolution(issueId)
      .then((res) => {
        setResolution(res);
        if (res.status === 'resolved') setSelectedRepoId(res.repository.id);
      })
      .catch(() => setResolution(null));
  }, [issueId]);

  const handleStatusChange = async (status: IssueStatus) => {
    if (!issue) return;
    const updated = await updateIssueStatus(issue.id, status);
    setIssue(updated.issue);
  };

  const handleAsk = async (question?: string) => {
    if (!issue || !scanMeta) return;
    const q = question ?? askInput;
    setAiLoading(true);
    setAskResponse('');
    try {
      const res = await askAi(q, issue, scanMeta.url);
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
      lensEvent.success('Fix proposal generated successfully.');
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
      lensEvent.success(`${result.provider === 'GITLAB' ? 'Merge Request' : 'Pull Request'} created`, {
        resource: result.branchName,
        detail: result.prNumber !== undefined ? `#${result.prNumber}` : undefined,
        icon: <PullRequestIcon />,
      });
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
      </div>
    );
  }

  return (
    <div className="dashboard issue-detail-page">
      <IssueHeader
        issue={issue}
        scanId={scanMeta.scanId}
        scanUrl={scanMeta.url}
        scannedAt={scanMeta.scannedAt}
        onShare={handleShareIssue}
        onExport={handleExportIssue}
        onStatusChange={handleStatusChange}
        actionMessage={actionMessage}
      />

      <div className="issue-detail-layout">
        <div className="issue-detail-main">
          <IssueHealthCard healthScore={scanMeta.healthScore} category={issue.category} />

          <IssueInsightCards issue={issue} />

          <EvidenceSection issue={issue} scanId={scanMeta.scanId} artifacts={scanArtifacts} />

          {'occurrences' in issue && issue.occurrences.length > 0 && (
            <Disclosure title="Affected Pages" meta={`${issue.affectedPages.length} pages`}>
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
            </Disclosure>
          )}

          <IssueAskAi
            askInput={askInput}
            setAskInput={setAskInput}
            onAsk={handleAsk}
            aiLoading={aiLoading}
            askResponse={askResponse}
            onSuggestFix={handleSuggestFix}
            fixResponse={fixResponse}
          />

          <IssueFixWithAi
            repositories={repositories}
            selectedRepoId={selectedRepoId}
            setSelectedRepoId={setSelectedRepoId}
            resolution={resolution}
            aiFixInstruction={aiFixInstruction}
            setAiFixInstruction={setAiFixInstruction}
            aiFixLoading={aiFixLoading}
            aiFixError={aiFixError}
            aiFixProposal={aiFixProposal}
            aiFixDecision={aiFixDecision}
            onProposeAiFix={handleProposeAiFix}
            onApproveProposal={handleApproveProposal}
            onRejectProposal={() => setAiFixDecision('rejected')}
            reviewLoading={reviewLoading}
            reviewError={reviewError}
            reviewResponse={reviewResponse}
            confirmingPr={confirmingPr}
            setConfirmingPr={setConfirmingPr}
            prLoading={prLoading}
            prError={prError}
            prResult={prResult}
            onCreatePr={handleCreatePr}
          />
        </div>

        <IssueSidebar
          issue={issue}
          scannedAt={scanMeta.scannedAt}
          relatedLinks={NO_RELATED_LINKS}
          fixProposed={aiFixProposal !== null}
          fixReviewed={reviewResponse !== null}
          prCreated={prResult !== null}
        />
      </div>
    </div>
  );
}
