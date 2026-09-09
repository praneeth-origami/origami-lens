import type { ReactNode } from 'react';

export type HealthBannerVariant = 'ok' | 'warning' | 'info' | 'error';

/** Simple line icons matching this project's existing inline-SVG convention (see StateViews.tsx) — currentColor so each variant's icon inherits its semantic color from CSS. Communicates state independently of color for accessibility. */
const ICONS: Record<HealthBannerVariant, ReactNode> = {
  ok: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13l4 4L19 7" />
    </svg>
  ),
  warning: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  ),
  info: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  ),
  error: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="m15 9-6 6M9 9l6 6" />
    </svg>
  ),
};

export interface HealthBannerProps {
  variant: HealthBannerVariant;
  children: ReactNode;
  /** Preserves each caller's existing ARIA usage exactly — not all current usages had a role, so this is opt-in rather than derived from variant. */
  role?: 'alert' | 'status';
}

/** Shared visual treatment for `.health-banner`'s ok/warning/info/error variants — see dashboard.css for the token-driven styling. */
export function HealthBanner({ variant, children, role }: HealthBannerProps) {
  return (
    <div className={`health-banner ${variant}`} role={role}>
      <span className="health-banner-icon" aria-hidden="true">{ICONS[variant]}</span>
      <span className="health-banner-content">{children}</span>
    </div>
  );
}
