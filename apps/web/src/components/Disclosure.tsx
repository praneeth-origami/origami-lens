import type { ReactNode } from 'react';

interface Props {
  title: string;
  meta?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Native <details>/<summary> gives keyboard support, focus handling, and
 * expanded/collapsed state announcements to screen readers for free — no
 * custom open-state JS or aria-expanded plumbing needed. Used to push
 * technical evidence (screenshots, page lists, recent activity) behind
 * progressive disclosure so the dashboard's first screen stays short
 * without discarding anything.
 */
export function Disclosure({ title, meta, defaultOpen = false, children }: Props) {
  return (
    <details className="disclosure" open={defaultOpen}>
      <summary className="disclosure-summary">
        <span className="disclosure-chevron" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
        <span className="disclosure-title">{title}</span>
        {meta && <span className="disclosure-meta">{meta}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
