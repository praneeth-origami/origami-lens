import { useState } from 'react';
import type { RepositoryPrStrategyPreviewResponse } from '@origami/contracts';
import { fetchRepositoryPrStrategy, githubPushConnectUrl } from '../api/client';
import { useOnVisible } from '../hooks/useOnVisible';
import { PrStrategyBadge } from './PrStrategyBadge';

interface RepoPrStrategyBadgeProps {
  repositoryId: string;
  /**
   * The backend route (`GET /repositories/:id/pr-strategy`) is gated to
   * OWNER/ADMIN (the same role that can actually approve a fix) — callers
   * pass `false` for any other role so this never fires a request that
   * would just 403, and renders nothing rather than a placeholder, since
   * the information isn't actionable for that role anyway.
   */
  enabled: boolean;
  small?: boolean;
}

/**
 * Lazy per-row "which PR method applies to this repository" badge — fetches
 * only once the row actually scrolls into view (useOnVisible), so a long
 * repositories table never fires N requests (some of which hit GitHub's own
 * API) the instant the page loads. Reused on both the repositories list
 * table and the Repository Detail header.
 */
export function RepoPrStrategyBadge({ repositoryId, enabled, small }: RepoPrStrategyBadgeProps) {
  const [result, setResult] = useState<RepositoryPrStrategyPreviewResponse | null>(null);
  const [failed, setFailed] = useState(false);

  const ref = useOnVisible<HTMLSpanElement>(() => {
    if (!enabled) return;
    fetchRepositoryPrStrategy(repositoryId)
      .then(setResult)
      .catch(() => setFailed(true));
  });

  if (!enabled) return null;

  return (
    <span ref={ref} className="repo-pr-strategy-slot">
      {result ? (
        result.strategy === 'ADMIN_APPROVAL_REQUIRED' ? (
          // Actionable right here, at the repository that actually needs it
          // — connects the user's own GitHub account for direct push/fork
          // access (the App itself requires an admin; this doesn't), rather
          // than sending them to hunt for the right card in the separate
          // account-connections panel.
          <a
            href={githubPushConnectUrl()}
            className="repo-pr-strategy-link"
            title={`${result.detail} Click to connect your GitHub account.`}
            // This badge is also used inside clickable table rows (see
            // RepositoriesListPage.tsx's <tr onClick={...}>) — without
            // this, clicking the link would ALSO trigger the row's
            // navigate-to-detail handler via event bubbling.
            onClick={(e) => e.stopPropagation()}
          >
            <PrStrategyBadge strategy={result.strategy} small={small} />
          </a>
        ) : (
          <PrStrategyBadge strategy={result.strategy} small={small} />
        )
      ) : (
        !failed && <span className="repo-pr-strategy-loading" aria-hidden="true">···</span>
      )}
    </span>
  );
}
