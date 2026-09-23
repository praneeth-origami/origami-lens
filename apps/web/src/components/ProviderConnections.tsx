import { useEffect, useState, type ComponentType } from 'react';
import type { ProviderConnectionSummary, RepositoryProvider } from '@origami/contracts';
import { bitbucketConnectUrl, disconnectProvider, fetchProviderConnections, githubConnectUrl, gitlabConnectUrl } from '../api/client';
import { lensEvent } from '../notifications/lens-event';
import { confirm } from '../notifications/confirm';
import { GitHubIcon, GitLabIcon, BitbucketIcon, LinkIcon, ArrowRightIcon } from './icons';

const PROVIDER_LABEL: Record<RepositoryProvider, string> = { GITHUB: 'GitHub', GITLAB: 'GitLab', BITBUCKET: 'Bitbucket' };
const CONNECT_URL: Partial<Record<RepositoryProvider, () => string>> = { GITHUB: githubConnectUrl, GITLAB: gitlabConnectUrl, BITBUCKET: bitbucketConnectUrl };
const PROVIDER_ICON: Record<RepositoryProvider, ComponentType> = { GITHUB: GitHubIcon, GITLAB: GitLabIcon, BITBUCKET: BitbucketIcon };

/** Bitbucket Cloud has no API for an app to revoke its own OAuth authorization (confirmed against Atlassian's own docs) — this is where a user has to go to do it themselves, so both the persistent hint and the post-disconnect note link here directly rather than just naming the page. */
const BITBUCKET_APP_AUTHORIZATIONS_URL = 'https://bitbucket.org/account/settings/app-authorizations/';

/**
 * "Connect GitHub" / "Connect GitLab" / "Connect Bitbucket" cards
 * (Phase 16/C-E) — the frontend never sees a token/refresh token/client
 * secret/authorization code, only connection status and a display-only
 * account login (see ProviderConnectionSummary).
 */
export function ProviderConnections() {
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

  const activeByProvider = new Map(connections.filter((c) => c.status === 'ACTIVE').map((c) => [c.provider, c]));

  return (
    <div className="provider-connections">
      <div className="provider-connections-header">
        <span className="provider-connections-icon" aria-hidden="true"><LinkIcon /></span>
        <div>
          <h2>Connect a repository</h2>
          <p>Link your GitHub, GitLab or Bitbucket repository to start analyzing your code.</p>
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
          const connection = activeByProvider.get(provider);
          const connectUrl = CONNECT_URL[provider]?.();
          const Icon = PROVIDER_ICON[provider];
          return (
            <div key={provider} className={`provider-card ${connection ? 'connected' : ''}`}>
              <span className="provider-card-icon" aria-hidden="true"><Icon /></span>
              <div className="provider-card-body">
                <span className="provider-card-name">{PROVIDER_LABEL[provider]}</span>
                {connection ? (
                  <span className="provider-card-status connected">
                    <span className="provider-card-status-dot" aria-hidden="true" />
                    Connected · {connection.externalAccountLogin}
                  </span>
                ) : (
                  <span className="provider-card-status">Analyze your {PROVIDER_LABEL[provider]} repositories</span>
                )}
              </div>
              {connection ? (
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
                  <button type="button" className="provider-disconnect" onClick={() => handleDisconnect(connection.id, provider)}>
                    Disconnect
                  </button>
                </div>
              ) : (
                connectUrl && (
                  <a className="provider-card-connect" href={connectUrl}>
                    Connect <ArrowRightIcon />
                  </a>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
