import { useEffect, useState } from 'react';
import { fetchAdminSystemHealth, type AdminSystemHealth } from '../../api/client';

const STATUS_DOT: Record<string, string> = { ok: '🟢', down: '🔴', not_configured: '⚪' };

export function AdminSystemHealthTab() {
  const [health, setHealth] = useState<AdminSystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAdminSystemHealth()
      .then(setHealth)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load system health'));
  }, []);

  if (error) return <p className="page-subtitle">{error}</p>;
  if (!health) return <p className="page-subtitle">Loading system health…</p>;

  return (
    <div className="admin-system-health-tab">
      <div className="summary-cards-row">
        <div className="summary-card">
          <span className="count">{STATUS_DOT[health.api.status]}</span>
          <span className="label">API</span>
        </div>
        <div className="summary-card">
          <span className="count">{STATUS_DOT[health.postgres.status]}</span>
          <span className="label">PostgreSQL</span>
        </div>
        <div className="summary-card">
          <span className="count">{STATUS_DOT[health.redis.status]}</span>
          <span className="label">Redis</span>
        </div>
        <div className="summary-card">
          <span className="count">{STATUS_DOT[health.aiRouter.status]}</span>
          <span className="label">AI Router</span>
        </div>
        <div className="summary-card">
          <span className="count">{STATUS_DOT[health.browserWorker.status]}</span>
          <span className="label">Browser Worker</span>
        </div>
      </div>

      <div className="section-title">Worker Queues</div>
      <div className="record-table-wrap">
        <table className="record-table">
          <thead>
            <tr>
              <th>Queue</th>
              <th>Active</th>
              <th>Waiting</th>
              <th>Delayed</th>
              <th>Failed</th>
            </tr>
          </thead>
          <tbody>
            {health.queues.map((q) => (
              <tr key={q.name}>
                <td>{q.name}</td>
                <td>{q.active}</td>
                <td>{q.waiting}</td>
                <td>{q.delayed}</td>
                <td>{q.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!health.redis.configured && <p className="billing-status-note">Redis is not configured — queue depths are unavailable.</p>}
    </div>
  );
}
