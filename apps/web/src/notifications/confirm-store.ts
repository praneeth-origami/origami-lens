/** Same tiny external-store pattern as toast-store.ts — see that file's doc comment for why (no state library, callable from anywhere). Only ever one active confirmation at a time, matching every existing confirmation site in this codebase (all were previously a single blocking window.confirm() call). */
export interface ConfirmOptions {
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  /** Styles the confirm button as destructive (matches every current window.confirm site — delete/remove/revoke/transfer) and keeps default focus on Cancel rather than the destructive action. */
  destructive?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

let activeRequest: ConfirmRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getConfirmSnapshot(): ConfirmRequest | null {
  return activeRequest;
}

export function setConfirmRequest(request: ConfirmRequest): void {
  activeRequest = request;
  emit();
}

export function resolveConfirm(confirmed: boolean): void {
  if (!activeRequest) return;
  activeRequest.resolve(confirmed);
  activeRequest = null;
  emit();
}
