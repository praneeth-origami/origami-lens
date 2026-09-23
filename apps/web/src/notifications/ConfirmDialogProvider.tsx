import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { subscribeConfirm, getConfirmSnapshot, resolveConfirm } from './confirm-store';

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Mounted once in App.tsx alongside ToastProvider — same "must be above
 * every route branch" reasoning (see ToastProvider.tsx's doc comment).
 * Renders nothing when there's no active confirm() call. Unlike
 * DetailDrawer.tsx (the only prior overlay in this codebase), this one
 * has real accessibility: a focus trap, Escape-to-cancel, aria-modal, and
 * focus restored to whatever triggered it — none of that existed anywhere
 * to reuse, so it's all new here.
 */
export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const request = useSyncExternalStore(subscribeConfirm, getConfirmSnapshot);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!request) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    // Default focus on Cancel, never the destructive action — a stray Enter should never confirm.
    cancelButtonRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolveConfirm(false);
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
  }, [request]);

  if (!request) return <>{children}</>;

  return (
    <>
      {children}
      <div className="confirm-dialog-overlay" onClick={() => resolveConfirm(false)}>
        <div
          ref={dialogRef}
          className="confirm-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          aria-describedby="confirm-dialog-description"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="confirm-dialog-title" className="confirm-dialog-title">{request.title}</h2>
          <p id="confirm-dialog-description" className="confirm-dialog-description">{request.description}</p>
          <div className="confirm-dialog-actions">
            <button ref={cancelButtonRef} type="button" className="ghost-button" onClick={() => resolveConfirm(false)}>
              {request.cancelText ?? 'Cancel'}
            </button>
            <button
              type="button"
              className={request.destructive ? 'confirm-dialog-destructive-button' : 'primary-button'}
              onClick={() => resolveConfirm(true)}
            >
              {request.confirmText ?? 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
