import { useEffect, useState } from 'react';
import type { ProviderConnectionSummary, RepositoryProvider } from '@origami/contracts';
import { bitbucketConnectUrl, disconnectProvider, fetchProviderConnections, githubConnectUrl, gitlabConnectUrl } from '../api/client';

const PROVIDER_LABEL: Record<RepositoryProvider, string> = { GITHUB: 'GitHub', GITLAB: 'GitLab', BITBUCKET: 'Bitbucket' };
const CONNECT_URL: Partial<Record<RepositoryProvider, () => string>> = { GITHUB: githubConnectUrl, GITLAB: gitlabConnectUrl, BITBUCKET: bitbucketConnectUrl };

/**
 * Minimal "Connect GitHub" / "Connect GitLab" / "Connect Bitbucket" UI
 * (Phase 16/C-E) — the frontend never sees a token/refresh token/client
 * secret/authorization code, only connection status and a display-only
 * account login (see ProviderConnectionSummary).
 */
export function ProviderConnections() {
  const [connections, setConnections] = useState<ProviderConnectionSummary[] | null>(null);

  const load = () => {
    fetchProviderConnections().then((data) => setConnections(data.connections));
  };

  useEffect(load, []);

  const handleDisconnect = async (id: string) => {
    await disconnectProvider(id);
    load();
  };

  if (!connections) return null;

  const activeByProvider = new Map(connections.filter((c) => c.status === 'ACTIVE').map((c) => [c.provider, c]));

  return (
    <div className="provider-connections">
      {(['GITHUB', 'GITLAB', 'BITBUCKET'] as RepositoryProvider[]).map((provider) => {
        const connection = activeByProvider.get(provider);
        const connectUrl = CONNECT_URL[provider]?.();
        return (
          <div key={provider} className="provider-connection-row">
            {connection ? (
              <>
                <span className="provider-connection-status">{PROVIDER_LABEL[provider]} Connected ({connection.externalAccountLogin})</span>
                <button type="button" className="provider-disconnect" onClick={() => handleDisconnect(connection.id)}>
                  Disconnect
                </button>
              </>
            ) : (
              connectUrl && (
                <a className="provider-connect" href={connectUrl}>
                  Connect {PROVIDER_LABEL[provider]}
                </a>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
