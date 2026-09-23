import { useEffect, useState } from 'react';
import type { AdminOverviewResponse, SubscriptionPlan } from '@origami/contracts';
import { fetchAdminOverview } from '../../api/client';

const POLL_INTERVAL_MS = 15000;
const PLANS: SubscriptionPlan[] = ['FREE', 'DEVELOPER', 'PRO', 'TEAM', 'AGENCY'];
const STATUS_DOT: Record<string, string> = { ok: '🟢', down: '🔴', not_configured: '⚪' };

/** The default admin tab — one call (GET /admin/overview), polled every 15s. Deliberately compact (8 metric cards + 3 small panels + a short recent-activity preview) rather than one giant scrolling page — the full activity table lives in its own tab. */
export function AdminOverviewTab() {
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchAdminOverview()
        .then((data) => {
          if (!cancelled) {
            setOverview(data);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load overview');
        });
    };
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (error && !overview) return <p className="page-subtitle">{error}</p>;
  if (!overview) return <p className="page-subtitle">Loading overview…</p>;

  const metrics = [
    { label: 'Total Users', value: overview.totalUsers },
    { label: 'Active Users', value: overview.activeNow.activeUsers },
    { label: 'Active Scans', value: overview.activeNow.activeScans },
    { label: 'Active AI Jobs', value: overview.activeNow.activeAiJobs },
    { label: 'Active Repository Jobs', value: overview.activeNow.activeRepositoryJobs },
    { label: 'Active Fix Jobs', value: overview.activeNow.activeFixWorkflows },
    { label: 'Total Workspaces', value: overview.totalWorkspaces },
    { label: 'Active Subscriptions', value: overview.subscriptions.byStatus.ACTIVE },
  ];

  return (
    <div className="admin-overview">
      <div className="admin-metric-grid">
        {metrics.map((m) => (
          <div className="summary-card" key={m.label}>
            <span className="count">{m.value}</span>
            <span className="label">{m.label}</span>
          </div>
        ))}
      </div>

      <div className="admin-overview-columns">
        <div className="admin-panel">
          <h3>Active Now</h3>
          <ul className="admin-active-now-list">
            <li>🟢 {overview.activeNow.activeUsers} users active</li>
            <li>🔵 {overview.activeNow.activeScans} scans running</li>
            <li>🟣 {overview.activeNow.activeAiJobs} AI jobs running</li>
            <li>🟠 {overview.activeNow.activeRepositoryJobs} repository jobs running</li>
            <li>🟢 {overview.activeNow.activeFixWorkflows} fix workflows running</li>
          </ul>
        </div>

        <div className="admin-panel">
          <h3>System Health</h3>
          <ul className="admin-health-list">
            <li>{STATUS_DOT[overview.systemHealth.api] ?? '⚪'} API</li>
            <li>{STATUS_DOT[overview.systemHealth.postgres] ?? '⚪'} PostgreSQL</li>
            <li>{STATUS_DOT[overview.systemHealth.redis] ?? '⚪'} Redis</li>
            <li>{STATUS_DOT[overview.systemHealth.aiRouter] ?? '⚪'} AI Router</li>
            <li>{STATUS_DOT[overview.systemHealth.browserWorker] ?? '⚪'} Browser Worker</li>
          </ul>
        </div>

        <div className="admin-panel">
          <h3>Subscriptions</h3>
          <ul className="admin-plan-list">
            {PLANS.map((plan) => (
              <li key={plan}>
                <span>{plan}</span>
                <span>{overview.subscriptions.byPlan[plan]}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="admin-panel">
        <h3>Recent Activity</h3>
        <ul className="admin-recent-activity-list">
          {overview.recentActivity.length === 0 && <li className="admin-empty">Nothing recent.</li>}
          {overview.recentActivity.map((item) => (
            <li key={item.id}>
              <span>
                {item.label}
                {item.targetLabel ? ` — ${item.targetLabel}` : ''}
              </span>
              <span className="admin-recent-activity-time">{new Date(item.updatedAt).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
