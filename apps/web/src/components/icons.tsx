import type { ReactNode } from 'react';

/**
 * The real Origami Lens brand mark (public/brand-icon.png — the actual
 * provided artwork, generated at 256px from a 1254px source; see
 * apps/extension/scripts/png-image.mjs for the decode/resize/encode used to
 * derive both this and the extension's icon48.png from the same source so
 * they never visually drift apart). This is the one place the mark is
 * defined — navbar, auth pages, pricing page, and favicon all render this
 * same component.
 */
export function OrigamiLensIcon({ size = 32, className }: { size?: number; className?: string }) {
  return <img src="/brand-icon.png" width={size} height={size} alt="" aria-hidden="true" className={className} />;
}

function StrokeIcon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export function SearchIcon() {
  return <StrokeIcon><circle cx="11" cy="11" r="7" /><path d="m21 21-4.35-4.35" /></StrokeIcon>;
}

export function SparkleIcon() {
  return <StrokeIcon><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M17.7 6.3l-2.1 2.1M8.4 15.6l-2.1 2.1" /></StrokeIcon>;
}

export function PullRequestIcon() {
  return <StrokeIcon><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M6 8.5V15.5M18 8.5a6 6 0 0 1-6 6h-2" /></StrokeIcon>;
}

/** A small lens-aperture glyph — the Lens Event system's own eyebrow marker (apps/web/src/notifications/LensEventCard.tsx), distinct from SearchIcon's magnifying glass. Six short "blades" around a center dot, evoking a camera aperture rather than a generic bullet/dot. */
export function ApertureIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 5v2.2M19 12h-2.2M12 19v-2.2M5 12h2.2M16.66 7.34l-1.56 1.56M16.66 16.66l-1.56-1.56M7.34 16.66l1.56-1.56M7.34 7.34l1.56 1.56" />
    </svg>
  );
}

/** Repository/code domain icon for richer Lens Event cards (repository connect/index/embed events) — none existed in this file before. */
export function CodeBracketIcon() {
  return <StrokeIcon size={16}><path d="M9 4 4 12l5 8M15 4l5 8-5 8" /></StrokeIcon>;
}

export function ChartIcon() {
  return <StrokeIcon><path d="M4 20V10M12 20V4M20 20v-7" /></StrokeIcon>;
}

/** Issue Detail redesign — Suggested Fix card icon. */
export function WrenchIcon() {
  return <StrokeIcon><path d="M14.7 6.3a4 4 0 0 0-5.4 4.6L4 16.2V20h3.8l5.3-5.3a4 4 0 0 0 4.6-5.4l-2.6 2.6-2.1-2.1 2.6-2.6Z" /></StrokeIcon>;
}

/** Issue Detail redesign — Console Errors evidence row icon. */
export function TerminalIcon() {
  return <StrokeIcon><rect x="3" y="4.5" width="18" height="15" rx="1.8" /><path d="m7 9.5 3 2.5-3 2.5M12.5 14.5h4.5" /></StrokeIcon>;
}

export function MailIcon() {
  return <StrokeIcon size={16}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></StrokeIcon>;
}

export function LockIcon() {
  return <StrokeIcon size={16}><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></StrokeIcon>;
}

export function UserIcon() {
  return <StrokeIcon size={16}><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20c1.5-4 5-6 7.5-6s6 2 7.5 6" /></StrokeIcon>;
}

export function EyeIcon() {
  return <StrokeIcon size={16}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></StrokeIcon>;
}

export function EyeOffIcon() {
  return <StrokeIcon size={16}><path d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.24 4.24M9.88 4.6A10.5 10.5 0 0 1 12 4.5c6.5 0 10 7 10 7a13.4 13.4 0 0 1-2.9 3.9M6.1 6.1C3.7 7.7 2 10 2 10s3.5 6.5 10 6.5c1.1 0 2.1-.16 3-.44" /></StrokeIcon>;
}

export function CheckIcon() {
  return <StrokeIcon size={16}><path d="M4 12.5l5 5L20 6.5" /></StrokeIcon>;
}

export function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7M18.5 7l-.8 12.1a2 2 0 0 1-2 1.9H8.3a2 2 0 0 1-2-1.9L5.5 7" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/** Nav icons (TopNav.tsx) — same StrokeIcon convention as MailIcon/LockIcon/UserIcon above, size 16 to sit compactly next to a label. */
export function HomeIcon() {
  return <StrokeIcon size={16}><path d="M4 11.5 12 4l8 7.5" /><path d="M6 10v9.5a1 1 0 0 0 1 1h3.5v-6h3v6H17a1 1 0 0 0 1-1V10" /></StrokeIcon>;
}

export function ActivityIcon() {
  return <StrokeIcon size={16}><path d="M3 12h4l2.5 7L14 5l2 7h5" /></StrokeIcon>;
}

export function CubeIcon() {
  return <StrokeIcon size={16}><path d="M12 3.5 20 8v8l-8 4.5L4 16V8Z" /><path d="M4 8l8 4.5L20 8M12 12.5V21" /></StrokeIcon>;
}

export function GitBranchIcon() {
  return <StrokeIcon size={16}><circle cx="6" cy="6" r="2.25" /><circle cx="6" cy="18" r="2.25" /><circle cx="17" cy="9" r="2.25" /><path d="M6 8.25V15.75M6 8.25a6 6 0 0 0 6 6h2.75" /></StrokeIcon>;
}

export function UsersIcon() {
  return <StrokeIcon size={16}><circle cx="9" cy="8" r="3" /><path d="M2.5 19c1.2-3.4 3.9-5 6.5-5s5.3 1.6 6.5 5" /><path d="M15.5 4.2A3 3 0 0 1 17 10M17.5 14c2.1.4 3.6 1.9 4.5 5" /></StrokeIcon>;
}

export function TagIcon() {
  return <StrokeIcon size={16}><path d="M11.5 3.5h-5a1 1 0 0 0-.7.3L3.3 6.3a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l6.5-6.5a1 1 0 0 0 0-1.4l-7-7a1 1 0 0 0-.7-.3Z" /><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" /></StrokeIcon>;
}

export function ShieldIcon() {
  return <StrokeIcon size={16}><path d="M12 3.5 19.5 6.5V11c0 5-3.5 8.2-7.5 9.5C8 19.2 4.5 16 4.5 11V6.5Z" /><path d="m9 12 2 2 4-4.5" /></StrokeIcon>;
}

export function ChevronDownIcon() {
  return <StrokeIcon size={14}><path d="M5 8.5 12 15l7-6.5" /></StrokeIcon>;
}

/** Export-menu icons (ReportExportMenu.tsx) — same StrokeIcon convention, size 16. */
export function DocumentIcon() {
  return <StrokeIcon size={16}><path d="M7 3.5h7l3 3v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" /><path d="M14 3.5v3h3" /><path d="M8.5 12h7M8.5 15h7M8.5 18h4" /></StrokeIcon>;
}

export function BracesIcon() {
  return <StrokeIcon size={16}><path d="M9 4c-2 0-2.5 1-2.5 3v1.5c0 1.3-.5 2-2 2.5 1.5.5 2 1.2 2 2.5V17c0 2 .5 3 2.5 3" /><path d="M15 4c2 0 2.5 1 2.5 3v1.5c0 1.3.5 2 2 2.5-1.5.5-2 1.2-2 2.5V17c0 2-.5 3-2.5 3" /></StrokeIcon>;
}

export function ListIcon() {
  return <StrokeIcon size={16}><path d="M8 6h11M8 12h11M8 18h11" /><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" /><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" /></StrokeIcon>;
}

export function TableIcon() {
  return <StrokeIcon size={16}><rect x="3.5" y="4.5" width="17" height="15" rx="1.5" /><path d="M3.5 10h17M9.5 4.5v15" /></StrokeIcon>;
}

/** Workspace Members page icons — same StrokeIcon convention, size 16. */
export function CrownIcon() {
  return <StrokeIcon size={16}><path d="M3.5 8.5 7 11l5-6 5 6 3.5-2.5-1.5 9h-14Z" /><path d="M6.5 19.5h11" /></StrokeIcon>;
}

export function MoreIcon() {
  return <StrokeIcon size={16}><circle cx="12" cy="5" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none" /></StrokeIcon>;
}

export function UserPlusIcon() {
  return <StrokeIcon size={18}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 19.5c1.3-3.7 3.9-5.5 6.5-5.5s5.2 1.8 6.5 5.5" /><path d="M18.5 8.5v5M16 11h5" /></StrokeIcon>;
}

export function LinkIcon() {
  return <StrokeIcon size={16}><path d="M9 15 15 9" /><path d="M11 6.5 12.2 5.3a3.5 3.5 0 1 1 5 5L16 11.5" /><path d="M13 17.5 11.8 18.7a3.5 3.5 0 1 1-5-5L8 12.5" /></StrokeIcon>;
}

export function ArrowRightIcon() {
  return <StrokeIcon size={14}><path d="M4 12h15" /><path d="m13 6 6 6-6 6" /></StrokeIcon>;
}

export function ExternalLinkIcon() {
  return <StrokeIcon size={14}><path d="M9 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" /><path d="M14 4h6v6" /><path d="M20 4 10 14" /></StrokeIcon>;
}

/** Repository summary/header decorative icon — a stacked-disk "connected data" glyph, distinct from CubeIcon (used for the Components nav item) so the two never read as the same concept. */
export function DatabaseIcon() {
  return <StrokeIcon size={20}><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6" /><path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" /></StrokeIcon>;
}

export function GlobeIcon() {
  return <StrokeIcon size={16}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3Z" /></StrokeIcon>;
}

export function ClockIcon() {
  return <StrokeIcon size={16}><circle cx="12" cy="12" r="9" /><path d="M12 7v5.5l3.5 2" /></StrokeIcon>;
}

export function CheckCircleIcon() {
  return <StrokeIcon size={16}><circle cx="12" cy="12" r="9" /><path d="m8 12.3 2.7 2.7L16.5 9" /></StrokeIcon>;
}

export function AlertTriangleIcon() {
  return <StrokeIcon size={16}><path d="M12 4 21.5 20H2.5Z" /><path d="M12 10v4.5M12 17.6v.01" /></StrokeIcon>;
}

export function RefreshIcon() {
  return <StrokeIcon size={16}><path d="M20 11a8 8 0 0 0-14.9-3.5M4 5v4h4" /><path d="M4 13a8 8 0 0 0 14.9 3.5M20 19v-4h-4" /></StrokeIcon>;
}

export function DownloadIcon() {
  return <StrokeIcon size={16}><path d="M12 4v11.5" /><path d="m7 11.5 5 5 5-5" /><path d="M4.5 19.5h15" /></StrokeIcon>;
}

export function MonitorIcon() {
  return <StrokeIcon size={16}><rect x="3" y="4.5" width="18" height="12" rx="1.5" /><path d="M8.5 20h7M12 16.5V20" /></StrokeIcon>;
}

export function TabletIcon() {
  return <StrokeIcon size={16}><rect x="5.5" y="3" width="13" height="18" rx="1.8" /><path d="M11.5 18.2h1" /></StrokeIcon>;
}

export function SmartphoneIcon() {
  return <StrokeIcon size={16}><rect x="7.5" y="2.5" width="9" height="19" rx="1.8" /><path d="M11.5 18.2h1" /></StrokeIcon>;
}

export function ImageIcon() {
  return <StrokeIcon size={16}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m5 18 5-5.5 3.5 3.8L17 12l3 4" /></StrokeIcon>;
}

export function FolderIcon() {
  return <StrokeIcon size={16}><path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-14a1.5 1.5 0 0 1-1.5-1.5Z" /></StrokeIcon>;
}

export function BookIcon() {
  return <StrokeIcon size={16}><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H12v18H5.5A1.5 1.5 0 0 1 4 19.5Z" /><path d="M20 4.5A1.5 1.5 0 0 0 18.5 3H12v18h6.5a1.5 1.5 0 0 0 1.5-1.5Z" /></StrokeIcon>;
}

export function MessageIcon() {
  return <StrokeIcon size={16}><path d="M4 5.5h16v10.5H9.5L5 20v-4H4Z" /></StrokeIcon>;
}

export function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.09 3.29 9.4 7.86 10.93.57.1.79-.25.79-.55 0-.27-.01-1.15-.02-2.09-3.2.7-3.87-1.36-3.87-1.36-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.43-2.69 5.4-5.26 5.69.41.36.78 1.06.78 2.14 0 1.54-.01 2.79-.01 3.17 0 .3.21.66.8.55A10.52 10.52 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  );
}

export function GitLabIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#FC6D26" d="M12 21.5 16.4 8.3H7.6L12 21.5Z" />
      <path fill="#E24329" d="M12 21.5 7.6 8.3H2.9L12 21.5Z" />
      <path fill="#FC6D26" d="M2.9 8.3 1.7 12a.9.9 0 0 0 .33 1L12 21.5 2.9 8.3Z" />
      <path fill="#FCA326" d="M2.9 8.3H7.6L5.65 2.4a.5.5 0 0 0-.95 0L2.9 8.3Z" />
      <path fill="#E24329" d="M12 21.5 16.4 8.3H21.1L12 21.5Z" />
      <path fill="#FC6D26" d="M21.1 8.3 22.3 12a.9.9 0 0 1-.33 1L12 21.5 21.1 8.3Z" />
      <path fill="#FCA326" d="M21.1 8.3H16.4L18.35 2.4a.5.5 0 0 1 .95 0L21.1 8.3Z" />
    </svg>
  );
}

export function BitbucketIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#2684FF"
        d="M2.4 3.5a.8.8 0 0 0-.79.93l3.28 19.85a1 1 0 0 0 .98.82h12.2a.8.8 0 0 0 .79-.66l3.28-20.01a.8.8 0 0 0-.79-.93H2.4Zm13.65 13.8H8l-1.78-9.3h11.56l-1.73 9.3Z"
      />
    </svg>
  );
}

export function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.57-5.17 3.57-8.82Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.88-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.27v3.11A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28V6.61H1.27A12 12 0 0 0 0 12c0 1.94.46 3.77 1.27 5.39l4-3.11Z" />
      <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.6 4.59 1.79l3.44-3.44C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.27 6.61l4 3.11C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  );
}
