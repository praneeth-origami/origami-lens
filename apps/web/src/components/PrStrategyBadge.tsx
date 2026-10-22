import type { RepositoryFixPrStrategy } from '@origami/contracts';
import { GitHubIcon, ForkIcon, LockIcon, ShieldIcon } from './icons';

/** Which PR method will (or did) create the pull request — see resolvePrStrategy (apps/api/src/repository-github-provider-client.ts). Purely a display concern; the strategy itself is always resolved server-side, per repository+user, never chosen by the frontend. Shared between IssueFixWithAi (per-finding preview/result) and the repositories list/detail pages (per-repository preview). */
export const PR_STRATEGY_META: Record<RepositoryFixPrStrategy | 'ADMIN_APPROVAL_REQUIRED', { label: string; icon: typeof GitHubIcon }> = {
  GITHUB_APP_DIRECT: { label: 'GitHub App', icon: GitHubIcon },
  USER_DIRECT: { label: 'Direct branch using your GitHub access', icon: LockIcon },
  USER_FORK: { label: 'Fork and Pull Request', icon: ForkIcon },
  ADMIN_APPROVAL_REQUIRED: { label: 'Admin approval required', icon: ShieldIcon },
};

export function PrStrategyBadge({ strategy, small }: { strategy: RepositoryFixPrStrategy | 'ADMIN_APPROVAL_REQUIRED'; small?: boolean }) {
  const meta = PR_STRATEGY_META[strategy];
  const Icon = meta.icon;
  return (
    <span className={`pr-strategy-badge ${strategy === 'ADMIN_APPROVAL_REQUIRED' ? 'warn' : ''} ${small ? 'small' : ''}`}>
      <Icon /> {meta.label}
    </span>
  );
}
