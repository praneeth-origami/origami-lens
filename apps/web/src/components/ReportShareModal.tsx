import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createOrRotateReportShare, getReportShareStatus, revokeReportShare, ApiRequestError } from '../api/client';
import { lensEvent } from '../notifications/lens-event';
import { confirm } from '../notifications/confirm';

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The raw share token is never stored anywhere persistent (only its hash
 * exists server-side, per report-share-service.ts) — this in-memory map is
 * the one place the web app keeps a just-created token, for the lifetime of
 * this tab only, purely so re-opening the modal within the same visit can
 * still show "Copy Link" without needing to rotate the link again.
 */
const sessionTokenCache = new Map<string, string>();

function ShareModal({ scanId, onClose }: { scanId: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(false);
  const [url, setUrl] = useState<string | null>(sessionTokenCache.has(scanId) ? `${window.location.origin}/reports/share/${sessionTokenCache.get(scanId)}` : null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    getReportShareStatus(scanId)
      .then((res) => setActive(res.active))
      .catch(() => setActive(false))
      .finally(() => setLoading(false));
  }, [scanId]);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previouslyFocusedRef.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreateOrRotate = async () => {
    setBusy(true);
    try {
      const result = await createOrRotateReportShare(scanId);
      sessionTokenCache.set(scanId, result.token);
      setUrl(result.url);
      setActive(true);
    } catch (err) {
      lensEvent.error(err instanceof ApiRequestError ? err.message : 'Could not create a share link.');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      lensEvent.warning('Could not copy automatically — select and copy the link manually.');
    }
  };

  const handleDisable = async () => {
    const confirmed = await confirm({
      title: 'Disable this share link?',
      description: 'Anyone who currently has this link will lose access to the report immediately.',
      confirmText: 'Disable link',
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await revokeReportShare(scanId);
      sessionTokenCache.delete(scanId);
      setActive(false);
      setUrl(null);
      lensEvent.success('Share link disabled.');
    } catch (err) {
      lensEvent.error(err instanceof ApiRequestError ? err.message : 'Could not disable the share link.');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="report-share-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="report-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-share-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="report-share-header">
          <h2 id="report-share-title">Share report</h2>
          <button type="button" ref={closeButtonRef} className="report-share-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <p className="report-share-description">Anyone with this link can view this report — no sign-in required.</p>

        {loading ? (
          <p className="page-subtitle">Checking link status…</p>
        ) : url ? (
          <>
            <div className="report-share-link-row">
              <input type="text" className="report-share-link-input" value={url} readOnly onFocus={(e) => e.target.select()} />
              <button type="button" className="primary-button" onClick={() => void handleCopy()}>
                {copied ? 'Copied!' : 'Copy Link'}
              </button>
            </div>
            <div className="report-share-divider" />
            <div className="report-share-status-row">
              <span className="report-share-status-label">Link status</span>
              <span className="report-share-status-active"><span className="report-share-status-dot" aria-hidden="true" />Active</span>
            </div>
            <button type="button" className="ghost-button report-share-disable-button" disabled={busy} onClick={() => void handleDisable()}>
              Disable Link
            </button>
          </>
        ) : active ? (
          <>
            <div className="report-share-status-row">
              <span className="report-share-status-label">Link status</span>
              <span className="report-share-status-active"><span className="report-share-status-dot" aria-hidden="true" />Active</span>
            </div>
            <p className="page-subtitle">A link is already active, but it can only be shown once, right when it's created. Generate a new one to copy it — the old link will stop working.</p>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void handleCreateOrRotate()}>
              Generate new link
            </button>
            <button type="button" className="ghost-button report-share-disable-button" disabled={busy} onClick={() => void handleDisable()}>
              Disable Link
            </button>
          </>
        ) : (
          <button type="button" className="primary-button" disabled={busy} onClick={() => void handleCreateOrRotate()}>
            {busy ? 'Creating…' : 'Create share link'}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function ReportShareButton({ scanId, disabled, disabledReason }: { scanId: string; disabled?: boolean; disabledReason?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="ghost-button" onClick={() => setOpen(true)} disabled={disabled} title={disabled ? disabledReason : undefined}>
        Share
      </button>
      {open && <ShareModal scanId={scanId} onClose={() => setOpen(false)} />}
    </>
  );
}
