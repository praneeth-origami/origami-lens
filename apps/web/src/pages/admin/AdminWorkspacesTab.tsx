import { useEffect, useState } from 'react';
import type { AdminWorkspaceSummary, SubscriptionPlan } from '@origami/contracts';
import { fetchAdminWorkspaces } from '../../api/client';

const PLANS: SubscriptionPlan[] = ['FREE', 'DEVELOPER', 'PRO', 'TEAM', 'AGENCY'];

export function AdminWorkspacesTab() {
  const [workspaces, setWorkspaces] = useState<AdminWorkspaceSummary[]>([]);
  const [plan, setPlan] = useState<SubscriptionPlan | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchAdminWorkspaces()
      .then((data) => setWorkspaces(data.workspaces))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load workspaces'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="page-subtitle">Loading workspaces…</p>;
  if (error) return <p className="page-subtitle">{error}</p>;

  const filtered = plan ? workspaces.filter((w) => w.plan === plan) : workspaces;

  return (
    <div className="admin-workspaces-tab">
      <div className="admin-filters-row">
        <select value={plan} onChange={(e) => setPlan(e.target.value as SubscriptionPlan | '')}>
          <option value="">All plans</option>
          {PLANS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div className="record-table-wrap">
        <table className="record-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Plan</th>
              <th>Members</th>
              <th>Owner</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((w) => (
              <tr key={w.id}>
                <td>{w.name}</td>
                <td>
                  <span className="badge">{w.plan}</span>
                </td>
                <td>{w.memberCount}</td>
                <td>{w.ownerEmail ?? '—'}</td>
                <td>{new Date(w.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
