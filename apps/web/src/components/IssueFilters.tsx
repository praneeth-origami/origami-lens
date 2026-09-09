import type { IssueFilters, IssueCategory, IssueStatus, Severity } from '@origami/contracts';
import { CATEGORY_LABEL, STATUS_LABEL, type SeverityTab } from '../api/client';

interface Props {
  severityTab: SeverityTab;
  onSeverityTab: (tab: SeverityTab) => void;
  filters: IssueFilters;
  onFiltersChange: (filters: IssueFilters) => void;
}

const CATEGORIES: (IssueCategory | 'all')[] = [
  'all', 'functional', 'performance', 'visualMobile', 'accessibility', 'bestPractices', 'seo', 'securityHygiene',
];

const STATUSES: (IssueStatus | 'all')[] = ['all', 'open', 'in_progress', 'resolved', 'ignored'];

export function IssueFiltersBar({ severityTab, onSeverityTab, filters, onFiltersChange }: Props) {
  const tabs: { id: SeverityTab; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'CRITICAL', label: 'Critical' },
    { id: 'HIGH', label: 'High' },
    { id: 'MEDIUM', label: 'Medium' },
    { id: 'LOW', label: 'Low' },
  ];

  return (
    <div className="filters-bar">
      <div className="severity-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab ${severityTab === tab.id ? 'active' : ''}`}
            onClick={() => onSeverityTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="filter-controls">
        <input
          type="search"
          placeholder="Search issues..."
          value={filters.search ?? ''}
          onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
          className="search-input"
        />

        <select
          value={filters.category ?? 'all'}
          onChange={(e) => onFiltersChange({ ...filters, category: e.target.value as IssueCategory | 'all' })}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c === 'all' ? 'Category ▼' : CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>

        <select
          value={filters.status ?? 'all'}
          onChange={(e) => onFiltersChange({ ...filters, status: e.target.value as IssueStatus | 'all' })}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === 'all' ? 'Status ▼' : STATUS_LABEL[s]}
            </option>
          ))}
        </select>

        <select
          value={filters.sort ?? 'severity'}
          onChange={(e) =>
            onFiltersChange({ ...filters, sort: e.target.value as IssueFilters['sort'] })
          }
        >
          <option value="severity">Sort: Severity</option>
          <option value="category">Sort: Category</option>
          <option value="newest">Sort: Newest</option>
          <option value="oldest">Sort: Oldest</option>
        </select>
      </div>
    </div>
  );
}
