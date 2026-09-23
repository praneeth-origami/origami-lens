import { useEffect, useState } from 'react';
import type { AdminUserDetail, AdminUserSummary, PlatformRole, SubscriptionPlan } from '@origami/contracts';
import { useAuth } from '../../hooks/useAuth';
import { fetchAdminUsers, fetchAdminUserDetail, updateUserPlatformRole, ApiRequestError } from '../../api/client';
import { DetailDrawer } from '../../components/DetailDrawer';
import { lensEvent } from '../../notifications/lens-event';

const ASSIGNABLE_PLATFORM_ROLES: PlatformRole[] = ['FOUNDER', 'ADMIN', 'USER'];
const PLANS: SubscriptionPlan[] = ['FREE', 'DEVELOPER', 'PRO', 'TEAM', 'AGENCY'];

export function AdminUsersTab() {
  const { user: currentUser } = useAuth();
  const isFounder = currentUser?.platformRole === 'FOUNDER';
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<PlatformRole | ''>('');
  const [plan, setPlan] = useState<SubscriptionPlan | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchAdminUsers({ search: search || undefined, role: role || undefined, plan: plan || undefined })
      .then((data) => setUsers(data.users))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load users'))
      .finally(() => setLoading(false));
  }, [search, role, plan]);

  const handleRoleChange = async (userId: string, platformRole: PlatformRole) => {
    setRoleError(null);
    setBusyUserId(userId);
    try {
      const { user: updated } = await updateUserPlatformRole(userId, platformRole);
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, platformRole: updated.platformRole } : u)));
      lensEvent.success('User role updated successfully.');
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'CANNOT_DEMOTE_LAST_FOUNDER') setRoleError('Cannot demote the last remaining Founder.');
      else setRoleError(err instanceof Error ? err.message : 'Could not update role.');
    } finally {
      setBusyUserId(null);
    }
  };

  const openDetail = (userId: string) => {
    fetchAdminUserDetail(userId)
      .then(setDetail)
      .catch(() => {});
  };

  return (
    <div className="admin-users-tab">
      <div className="admin-filters-row">
        <input type="text" placeholder="Search by email or name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value as PlatformRole | '')}>
          <option value="">All roles</option>
          {ASSIGNABLE_PLATFORM_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select value={plan} onChange={(e) => setPlan(e.target.value as SubscriptionPlan | '')}>
          <option value="">All plans</option>
          {PLANS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      {roleError && <p className="billing-status-note">{roleError}</p>}
      {error && <p className="billing-status-note">{error}</p>}

      {loading ? (
        <p className="page-subtitle">Loading users…</p>
      ) : (
        <div className="record-table-wrap">
          <table className="record-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Plan</th>
                <th>Platform role</th>
                <th>Workspaces</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="admin-activity-row" onClick={() => openDetail(u.id)}>
                  <td>{u.email ?? '—'}</td>
                  <td>{u.displayName ?? '—'}</td>
                  <td>
                    <span className="badge">{u.plan ?? 'FREE'}</span>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {isFounder ? (
                      <select
                        value={u.platformRole}
                        disabled={busyUserId === u.id}
                        onChange={(e) => void handleRoleChange(u.id, e.target.value as PlatformRole)}
                      >
                        {ASSIGNABLE_PLATFORM_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="badge">{u.platformRole}</span>
                    )}
                  </td>
                  <td>{u.workspaceCount}</td>
                  <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <DetailDrawer title={detail.displayName ?? detail.email ?? 'User'} onClose={() => setDetail(null)}>
          <div className="detail-drawer-row">
            <span>Email</span>
            <span>{detail.email ?? '—'}</span>
          </div>
          <div className="detail-drawer-row">
            <span>Platform role</span>
            <span>{detail.platformRole}</span>
          </div>
          <div className="detail-drawer-row">
            <span>Plan</span>
            <span>{detail.subscriptionPlan ?? 'FREE'}</span>
          </div>
          <div className="detail-drawer-row">
            <span>Created</span>
            <span>{new Date(detail.createdAt).toLocaleString()}</span>
          </div>
          <div className="detail-drawer-row">
            <span>Last active</span>
            <span>{detail.lastActiveAt ? new Date(detail.lastActiveAt).toLocaleString() : 'Never'}</span>
          </div>
          <h3 className="detail-drawer-subheading">Workspaces</h3>
          {detail.workspaces.length === 0 && <p className="admin-empty">No workspace memberships.</p>}
          {detail.workspaces.map((w) => (
            <div className="detail-drawer-row" key={w.organizationId}>
              <span>{w.organizationName}</span>
              <span>{w.role}</span>
            </div>
          ))}
          <h3 className="detail-drawer-subheading">Usage today</h3>
          {detail.usageToday.map((u) => (
            <div className="detail-drawer-row" key={u.metric}>
              <span>{u.metric}</span>
              <span>
                {u.count}
                {u.limit !== null ? ` / ${u.limit}` : ''}
              </span>
            </div>
          ))}
        </DetailDrawer>
      )}
    </div>
  );
}
