import { useEffect, useState } from 'react';
import type { AdminActivityItem, AdminActivityType } from '@origami/contracts';
import { fetchAdminActivity } from '../../api/client';
import { DetailDrawer } from '../../components/DetailDrawer';

const POLL_INTERVAL_MS = 15000;

const TYPES: { value: AdminActivityType | ''; label: string }[] = [
  { value: '', label: 'All types' },
  { value: 'SCAN', label: 'Scans' },
  { value: 'AI_JOB', label: 'AI Jobs' },
  { value: 'REPOSITORY_JOB', label: 'Repository Jobs' },
  { value: 'FIX_WORKFLOW', label: 'Fix Workflows' },
];

function elapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The live "what's running right now" view — polled, filterable, bounded (the API caps this at 200 items regardless of what's requested). */
export function AdminActivityTab() {
  const [items, setItems] = useState<AdminActivityItem[]>([]);
  const [type, setType] = useState<AdminActivityType | ''>('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminActivityItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchAdminActivity({ type: type || undefined, status: status || undefined })
        .then((data) => {
          if (!cancelled) {
            setItems(data.items);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load activity');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    setLoading(true);
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [type, status]);

  return (
    <div className="admin-activity-tab">
      <div className="admin-filters-row">
        <select value={type} onChange={(e) => setType(e.target.value as AdminActivityType | '')}>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <input type="text" placeholder="Filter by status (e.g. RUNNING)" value={status} onChange={(e) => setStatus(e.target.value)} />
      </div>

      {error && <p className="billing-status-note">{error}</p>}
      {loading ? (
        <p className="page-subtitle">Loading activity…</p>
      ) : (
        <div className="record-table-wrap">
          <table className="record-table">
            <thead>
              <tr>
                <th>Activity</th>
                <th>Target</th>
                <th>Status</th>
                <th>Elapsed</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={4} className="admin-empty">
                    Nothing active right now.
                  </td>
                </tr>
              )}
              {items.map((item) => (
                <tr key={item.id} onClick={() => setSelected(item)} className="admin-activity-row">
                  <td>{item.label}</td>
                  <td>{item.targetLabel ?? '—'}</td>
                  <td>
                    <span className="badge">{item.status}</span>
                  </td>
                  <td>{elapsed(item.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <DetailDrawer title={selected.label} onClose={() => setSelected(null)}>
          <div className="detail-drawer-row">
            <span>Target</span>
            <span>{selected.targetLabel ?? '—'}</span>
          </div>
          <div className="detail-drawer-row">
            <span>Status</span>
            <span>{selected.status}</span>
          </div>
          <div className="detail-drawer-row">
            <span>Started</span>
            <span>{new Date(selected.startedAt).toLocaleString()}</span>
          </div>
          <div className="detail-drawer-row">
            <span>Elapsed</span>
            <span>{elapsed(selected.startedAt)}</span>
          </div>
          <div className="detail-drawer-row">
            <span>Last updated</span>
            <span>{new Date(selected.updatedAt).toLocaleString()}</span>
          </div>
        </DetailDrawer>
      )}
    </div>
  );
}
