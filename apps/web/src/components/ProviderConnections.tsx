import { useEffect, useState, type ComponentType } from 'react';
import type { ProviderConnectionSummary, Repository, RepositoryProvider } from '@origami/contracts';
import { disconnectProvider, fetchProviderConnections } from '../api/client';
import { lensEvent } from '../notifications/lens-event';
import { confirm } from '../notifications/confirm';
import { GitHubIcon, GitLabIcon, BitbucketIcon, LinkIcon, LockIcon } from './icons';

const PROVIDER_LABEL: Record<RepositoryProvider, string> = { GITHUB: 'GitHub', GITLAB: 'GitLab', BITBUCKET: 'Bitbucket' };
const PROVIDER_ICON: Record<RepositoryProvider, ComponentType> = { GITHUB: GitHubIcon, GITLAB: GitLabIcon, BITBUCKET: BitbucketIcon };

/** Bitbucket Cloud has no API for an app to revoke its own OAuth authorization (confirmed against Atlassian's own docs) — this is where a user has to go to do it themselves, so both the persistent hint and the post-disconnect note link here directly rather than just naming the page. */
const BITBUCKET_APP_AUTHORIZATIONS_URL = 'https://bitbucket.org/account/settings/app-authorizations/';

/** The account login a connected repository's URL belongs to (e.g. "acme-corp" from github.com/acme-corp/widgets) — used only to COUNT how many of the user's already-connected repositories a given GitHub connection covers, never as an authorization check (that's still always resolved server-side, per repository, by resolvePrStrategy). */
function repoUrlOwner(repoUrl: string): string {
  try {
    return new URL(repoUrl).pathname.split('/').filter(Boolean)[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * Status panel for GitLab/Bitbucket "Connect" + read-only GitHub connection
 * status (Phase 16/C-E, revised) — the frontend never sees a token/refresh
 * token/client secret/authorization code, only connection status and a
 * display-only account login (see ProviderConnectionSummary). GitHub is
 * connected from a repository's own page (list row / detail header), not
 * here — this panel only shows which GitHub accounts are already connected
 * and how many of the user's repositories each one covers.
 */
export function ProviderConnections({ repositories }: { repositories: Repository[] }) {
  const [connections, setConnections] = useState<ProviderConnectionSummary[] | null>(null);
  const [warning, setWarning] = useState('');
  const [showBitbucketNote, setShowBitbucketNote] = useState(false);

  const load = () => {
    fetchProviderConnections().then((data) => setConnections(data.connections));
  };

  useEffect(load, []);

  const handleDisconnect = async (id: string, provider: RepositoryProvider) => {
    const confirmed = await confirm({
      title: `Disconnect ${PROVIDER_LABEL[provider]}?`,
      description: `Origami Lens will no longer be able to access your ${PROVIDER_LABEL[provider]} repositories until you reconnect.`,
      confirmText: 'Disconnect',
      destructive: true,
    });
    if (!confirmed) return;

    const result = await disconnectProvider(id);
    // Separate from `warning`: githubUninstallError means something went
    // wrong on our end; bitbucketManualRevokeRequired is always true for
    // Bitbucket and isn't a failure — it gets its own, non-error-styled note.
    setWarning(
      result.githubUninstallError
        ? 'Disconnected from Origami Lens, but the App could not be removed from GitHub automatically — remove it from github.com/settings/installations if you want to revoke its access there too.'
        : '',
    );
    setShowBitbucketNote(Boolean(result.bitbucketManualRevokeRequired));
    if (!result.githubUninstallError) lensEvent.success(`${PROVIDER_LABEL[provider]} disconnected successfully.`);
    load();
  };

  if (!connections) return null;

  /**
   * Grouped by provider, NOT collapsed to one — GitHub genuinely supports
   * multiple simultaneous active connections (one per GitHub App
   * installation, i.e. one per personal account/org the App is installed
   * on; see migration 013's `UNIQUE (provider, installation_id)`, which
   * has no per-user uniqueness at all). Collapsing to a single entry per
   * provider (the previous `Map<provider, connection>` shape) silently
   * dropped every GitHub connection but one whenever a user had connected
   * more than one GitHub account/org. GitLab and Bitbucket really are
   * one-active-connection-per-user (enforced application-side in
   * upsertGitLabConnection/upsertBitbucketConnection), so grouping still
   * naturally yields at most one entry for those two.
   */
  const activeByProvider = new Map<RepositoryProvider, ProviderConnectionSummary[]>();
  for (const c of connections) {
    // DIRECT_PUSH is a different capability from an App installation (see
    // ProviderConnectionSummary's doc comment) — rendered in its own card
    // below, never mixed into the "GitHub App" group.
    if (c.status !== 'ACTIVE' || c.connectionKind === 'DIRECT_PUSH') continue;
    const list = activeByProvider.get(c.provider);
    if (list) list.push(c);
    else activeByProvider.set(c.provider, [c]);
  }
  const githubDirectPush = connections.find((c) => c.provider === 'GITHUB' && c.status === 'ACTIVE' && c.connectionKind === 'DIRECT_PUSH');
  const totalConnectedAccounts = connections.filter((c) => c.status === 'ACTIVE').length;

  return (
    <div className="provider-connections">
      <div className="provider-connections-header">
        <span className="provider-connections-icon" aria-hidden="true"><LinkIcon /></span>
        <div>
          <h2>Connected accounts</h2>
          <p>
            {totalConnectedAccounts} {totalConnectedAccounts === 1 ? 'account' : 'accounts'} connected. GitHub is connected from a repository's own page.
          </p>
        </div>
      </div>

      {warning && <p className="provider-connection-warning">{warning}</p>}
      {showBitbucketNote && (
        <p className="provider-connection-note">
          Disconnected from Origami Lens. Bitbucket doesn't support revoking app access automatically — visit{' '}
          <a href={BITBUCKET_APP_AUTHORIZATIONS_URL} target="_blank" rel="noreferrer">
            Bitbucket App authorizations
          </a>{' '}
          if you want to revoke it there too.
        </p>
      )}

      <div className="provider-card-grid">
        {(['GITHUB', 'GITLAB', 'BITBUCKET'] as RepositoryProvider[]).map((provider) => {
          const providerConnections = activeByProvider.get(provider) ?? [];
          const Icon = PROVIDER_ICON[provider];

          if (providerConnections.length === 0) {
            return (
              <div key={provider} className="provider-card">
                <span className="provider-card-icon" aria-hidden="true"><Icon /></span>
                <div className="provider-card-body">
                  <span className="provider-card-name">{PROVIDER_LABEL[provider]}</span>
                  <span className="provider-card-status">Not connected</span>
                </div>
              </div>
            );
          }

          return providerConnections.map((connection) => {
            const repoCount = provider === 'GITHUB'
              ? repositories.filter((r) => r.provider === 'GITHUB' && repoUrlOwner(r.repoUrl).toLowerCase() === connection.externalAccountLogin.toLowerCase()).length
              : undefined;
            return (
              <div key={connection.id} className="provider-card connected">
                <span className="provider-card-icon" aria-hidden="true"><Icon /></span>
                <div className="provider-card-body">
                  <span className="provider-card-name">{PROVIDER_LABEL[provider]}</span>
                  <span className="provider-card-status connected">
                    <span className="provider-card-status-dot" aria-hidden="true" />
                    Connected · {connection.externalAccountLogin}
                    {repoCount !== undefined && ` · ${repoCount} ${repoCount === 1 ? 'repository' : 'repositories'}`}
                  </span>
                </div>
                <div className="provider-card-actions">
                  {provider === 'BITBUCKET' && (
                    <a
                      className="provider-connection-hint"
                      href={BITBUCKET_APP_AUTHORIZATIONS_URL}
                      target="_blank"
                      rel="noreferrer"
                      title="Disconnect here only removes access from Origami Lens — revoke on Bitbucket separately if needed"
                    >
                      manage on Bitbucket
                    </a>
                  )}
                  {/* <button type="button" className="provider-disconnect" onClick={() => handleDisconnect(connection.id, provider)}>
                    Disconnect
                  </button> */}
                </div>
              </div>
            );
          });
        })}

        {/*
          A DIFFERENT capability from the "GitHub" App-installation cards
          above — lets a user create pull requests on a company repo an
          admin never installed the App on, using their own GitHub access
          (direct push, or fork + PR) instead. See resolvePrStrategy /
          Fix with AI's PR-method preview. Also connected from a repository's
          own page, never from a button here.
        */}
        {githubDirectPush ? (
          <div className="provider-card connected">
            <span className="provider-card-icon" aria-hidden="true"><LockIcon /></span>
            <div className="provider-card-body">
              <span className="provider-card-name">GitHub — direct push access</span>
              <span className="provider-card-status connected">
                <span className="provider-card-status-dot" aria-hidden="true" />
                Connected · {githubDirectPush.externalAccountLogin}
              </span>
            </div>
            <div className="provider-card-actions">
              {/* <button type="button" className="provider-disconnect" onClick={() => handleDisconnect(githubDirectPush.id, 'GITHUB')}>
                Disconnect
              </button> */}
            </div>
          </div>
        ) : (
          <div className="provider-card">
            <span className="provider-card-icon" aria-hidden="true"><LockIcon /></span>
            <div className="provider-card-body">
              <span className="provider-card-name">GitHub — direct push access</span>
              <span className="provider-card-status">Not connected — connect from a repository showing "Admin approval required"</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
