import { setConfirmRequest, type ConfirmOptions } from './confirm-store';

/**
 * The global confirmation API — confirm({title, description, confirmText,
 * cancelText, destructive}) => Promise<boolean>, exactly matching the
 * approved spec's own signature. Replaces every window.confirm(...) site
 * in this codebase (native, unstyled, no keyboard/focus handling) with a
 * real accessible dialog (see ConfirmDialogProvider.tsx).
 *
 * Usage: `if (!(await confirm({ title: '...', description: '...', destructive: true }))) return;`
 * — same early-return shape every existing window.confirm(...) call already uses.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    setConfirmRequest({ ...options, resolve });
  });
}
