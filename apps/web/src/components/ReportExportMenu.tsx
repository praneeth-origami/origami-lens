import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import type { ReportExportFormat } from '@origami/contracts';
import { downloadReportExport, ApiRequestError } from '../api/client';
import { lensEvent } from '../notifications/lens-event';
import { DocumentIcon, BracesIcon, ListIcon, TableIcon, ChevronDownIcon } from './icons';

interface ExportOption {
  format: ReportExportFormat;
  icon: ComponentType;
  label: string;
  description: string;
}

/** PDF first (the primary human-facing report), CSV last (never the primary option) — matches the approved spec's explicit ordering. */
const EXPORT_OPTIONS: ExportOption[] = [
  { format: 'pdf', icon: DocumentIcon, label: 'PDF', description: 'Client-ready report' },
  { format: 'json', icon: BracesIcon, label: 'JSON', description: 'Developer/API data' },
  { format: 'markdown', icon: ListIcon, label: 'Markdown', description: 'Developer-friendly' },
  { format: 'csv', icon: TableIcon, label: 'CSV', description: 'Issue spreadsheet' },
];

/**
 * Self-contained dropdown, structurally copied from TopNav.tsx's
 * ProfileMenu (own open state, click-outside, Escape-to-close, focus-
 * return-to-trigger). The menu PANEL is rendered via a portal to
 * document.body — this page's trigger sits inside ScanSummary's
 * `.animate-in` section, whose CSS `animation` makes it a stacking/
 * containing-block context for any descendant that isn't portaled out,
 * which would otherwise trap the dropdown beneath later page sections
 * (confirmed live: menu items 3/4 were unclickable, covered by
 * .health-summary). Portaling sidesteps that entirely, the same way real
 * popover/menu libraries do.
 */
export function ReportExportMenu({ scanId, disabled, disabledReason }: { scanId: string; disabled?: boolean; disabledReason?: string }) {
  const [open, setOpen] = useState(false);
  const [pendingFormat, setPendingFormat] = useState<ReportExportFormat | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const updatePosition = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      setMenuPosition({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    };
    updatePosition();
    // A dropdown that stays open across a scroll/resize without following
    // its trigger would look broken — closing is simpler and safer than
    // tracking every layout change.
    const handleLayoutChange = () => setOpen(false);
    window.addEventListener('scroll', handleLayoutChange, true);
    window.addEventListener('resize', handleLayoutChange);
    return () => {
      window.removeEventListener('scroll', handleLayoutChange, true);
      window.removeEventListener('resize', handleLayoutChange);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleExport = async (format: ReportExportFormat) => {
    setOpen(false);
    setPendingFormat(format);
    try {
      await downloadReportExport(scanId, format);
      lensEvent.success(`Exported as ${format.toUpperCase()}`);
    } catch (err) {
      if (!(err instanceof ApiRequestError)) {
        lensEvent.error('Could not export the report.');
      }
    } finally {
      setPendingFormat(null);
    }
  };

  return (
    <div className="report-export-menu-container" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="primary-button report-export-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || pendingFormat !== null}
        title={disabled ? disabledReason : undefined}
      >
        {pendingFormat ? 'Exporting…' : 'Export'}
        <ChevronDownIcon />
      </button>

      {open && menuPosition &&
        createPortal(
          <div
            ref={menuRef}
            className="report-export-menu"
            role="menu"
            aria-label="Export report"
            style={{ position: 'fixed', top: menuPosition.top, right: menuPosition.right }}
          >
            <div className="report-export-menu-heading">Export report</div>
            {EXPORT_OPTIONS.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.format}
                  type="button"
                  role="menuitem"
                  className="report-export-menu-item"
                  onClick={() => void handleExport(option.format)}
                >
                  <span className="report-export-menu-item-icon" aria-hidden="true"><Icon /></span>
                  <span className="report-export-menu-item-copy">
                    <span className="report-export-menu-item-label">{option.label}</span>
                    <span className="report-export-menu-item-description">{option.description}</span>
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
