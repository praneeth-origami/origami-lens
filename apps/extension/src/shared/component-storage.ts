/// <reference types="chrome" />
import type { CodeTarget } from '@origami/contracts';

export const COMPONENT_STORAGE_KEYS = {
  ACTIVE_JOB: 'activeComponentJob',
} as const;

export type ComponentJobStatus = 'QUEUED' | 'RUNNING' | 'BLOCKED_PRIVACY' | 'COMPLETED' | 'FAILED';

export interface PersistedComponentJob {
  jobId: string;
  sourceUrl: string;
  target: CodeTarget;
  status: ComponentJobStatus;
  componentName?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

const TERMINAL_STATUSES: ComponentJobStatus[] = ['COMPLETED', 'FAILED', 'BLOCKED_PRIVACY'];

export function isComponentJobInProgress(status: ComponentJobStatus): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

export function isComponentJobTerminal(status: ComponentJobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export async function getActiveComponentJob(): Promise<PersistedComponentJob | null> {
  const data = await chrome.storage.local.get(COMPONENT_STORAGE_KEYS.ACTIVE_JOB);
  const job = data[COMPONENT_STORAGE_KEYS.ACTIVE_JOB] as PersistedComponentJob | undefined;
  return job ?? null;
}

export async function setActiveComponentJob(job: PersistedComponentJob | null): Promise<void> {
  if (job) {
    await chrome.storage.local.set({ [COMPONENT_STORAGE_KEYS.ACTIVE_JOB]: job });
  } else {
    await chrome.storage.local.remove(COMPONENT_STORAGE_KEYS.ACTIVE_JOB);
  }
}
