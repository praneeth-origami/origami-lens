import { useState } from 'react';
import { AdminOverviewTab } from './admin/AdminOverviewTab';
import { AdminActivityTab } from './admin/AdminActivityTab';
import { AdminUsersTab } from './admin/AdminUsersTab';
import { AdminWorkspacesTab } from './admin/AdminWorkspacesTab';
import { AdminSystemHealthTab } from './admin/AdminSystemHealthTab';

type Tab = 'overview' | 'activity' | 'users' | 'workspaces' | 'health';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'users', label: 'Users' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'health', label: 'System health' },
];

/**
 * Platform administration — an operational control center, not just a user
 * list. Overview is the default: compact top metrics + Active Now + a
 * short recent-activity preview. Deeper drill-down (the full live activity
 * table, user search/detail, workspace list, per-queue worker health) each
 * gets its own tab rather than one long scrolling page.
 */
export function AdminPage() {
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <div className="list-page animate-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">Platform administration</h1>
          <p className="page-subtitle">What's running right now, who's using Origami Lens, and how the system is doing.</p>
        </div>
      </div>

      <div className="pricing-toggle" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <AdminOverviewTab />}
      {tab === 'activity' && <AdminActivityTab />}
      {tab === 'users' && <AdminUsersTab />}
      {tab === 'workspaces' && <AdminWorkspacesTab />}
      {tab === 'health' && <AdminSystemHealthTab />}
    </div>
  );
}
