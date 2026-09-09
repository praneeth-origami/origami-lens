import { useEffect, useState } from 'react';
import { fetchDependencyHealth, type DependencyHealth } from '../api/client';
import { HealthBanner } from './HealthBanner';

export function ServiceHealthBanner() {
  const [health, setHealth] = useState<DependencyHealth | null>(null);
  const [apiDown, setApiDown] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const data = await fetchDependencyHealth();
        if (!cancelled) {
          setHealth(data);
          setApiDown(false);
        }
      } catch {
        if (!cancelled) {
          setApiDown(true);
          setHealth(null);
        }
      }
    };

    poll();
    const id = setInterval(poll, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (apiDown) {
    return (
      <HealthBanner variant="error" role="alert">
        Origami API is unreachable. Run <code>pnpm dev</code> in the project root, then refresh.
      </HealthBanner>
    );
  }

  if (!health) return null;

  if (health.browserWorker.status === 'down') {
    return (
      <HealthBanner variant="warning" role="status">
        Browser worker is down — scans will use extension-only evidence. Start with <code>pnpm dev</code>.
      </HealthBanner>
    );
  }

  if (health.aiRouter.status === 'down') {
    return (
      <HealthBanner variant="info" role="status">
        AI router unavailable — deterministic explanations only.
      </HealthBanner>
    );
  }

  return null;
}
