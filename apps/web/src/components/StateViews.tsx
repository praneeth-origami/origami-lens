export function LoadingSkeleton() {
  return (
    <div className="loading-skeleton" role="status" aria-label="Loading">
      <div className="sk-block sk-header" />
      <div className="sk-block sk-score" />
      <div className="sk-block sk-list" />
      <div className="sk-block sk-list" />
    </div>
  );
}

const HOW_IT_WORKS = [
  { step: '1', title: 'Scan', copy: 'Run a scan from the Origami Lens Chrome extension — a single page or an entire website.' },
  { step: '2', title: 'Ask', copy: 'Every issue explains what happened, why, and who it affects — ask AI for more detail on any of them.' },
  { step: '3', title: 'Fix', copy: 'Follow the suggested fix, or generate working code for a component with Screenshot → Code.' },
];

export function EmptyState({ hasScans }: { hasScans: boolean }) {
  if (hasScans) {
    return (
      <div className="empty-state">
        <p>Select a scan to view its report, or run a new one from the extension.</p>
      </div>
    );
  }

  return (
    <div className="empty-state empty-state-hero animate-in">
      <div className="empty-state-icon" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
      </div>
      <h2>Your website health starts here.</h2>
      <p className="empty-state-lede">
        Run your first scan to uncover functional, performance, visual, accessibility, SEO, and security issues —
        each with a clear cause, impact, and suggested fix.
      </p>

      <ol className="how-it-works">
        {HOW_IT_WORKS.map((item) => (
          <li key={item.step}>
            <span className="how-it-works-step">{item.step}</span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.copy}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="empty-state-cta">
        <p>Open the <strong>Origami Lens</strong> extension on any webpage, then choose <strong>Current Page</strong> or <strong>Entire Website</strong>.</p>
      </div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <div className="error-state-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v5M12 16.5v.01" />
        </svg>
      </div>
      <h2>Unable to load your latest scan.</h2>
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="btn-primary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
