import type { ReactNode } from 'react';

/** A minimal slide-in side panel — no modal/drawer primitive existed anywhere in this codebase yet, so this is the one shared implementation for the admin activity/user detail views. */
export function DetailDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="detail-drawer-overlay" onClick={onClose}>
      <div className="detail-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="detail-drawer-header">
          <h2>{title}</h2>
          <button type="button" className="ghost-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="detail-drawer-body">{children}</div>
      </div>
    </div>
  );
}
