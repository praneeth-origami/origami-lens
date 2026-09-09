/// <reference types="chrome" />
import { API_BASE } from '../types/scan.js';
import type { CodeTarget, ComponentEvidence } from '@origami/contracts';
import {
  getActiveComponentJob,
  isComponentJobInProgress,
  isComponentJobTerminal,
  setActiveComponentJob,
  type ComponentJobStatus,
  type PersistedComponentJob,
} from '../shared/component-storage.js';

export const COMPONENT_POLL_ALARM = 'origami-component-poll';

interface ComponentJobStatusResponse {
  jobId: string;
  status: ComponentJobStatus;
  error?: string;
  result?: { componentName: string };
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ensurePollAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(COMPONENT_POLL_ALARM);
  if (!existing) {
    await chrome.alarms.create(COMPONENT_POLL_ALARM, { periodInMinutes: 0.5 });
  }
}

async function clearPollAlarm(): Promise<void> {
  await chrome.alarms.clear(COMPONENT_POLL_ALARM);
}

export async function refreshActiveComponentJob(): Promise<PersistedComponentJob | null> {
  const active = await getActiveComponentJob();
  if (!active || isComponentJobTerminal(active.status)) return active;

  try {
    const res = await fetch(`${API_BASE}/components/${active.jobId}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return active;

    const job = (await res.json()) as ComponentJobStatusResponse;
    const updated: PersistedComponentJob = {
      ...active,
      status: job.status,
      error: job.error,
      componentName: job.result?.componentName ?? active.componentName,
      updatedAt: nowIso(),
    };
    await setActiveComponentJob(updated);

    if (isComponentJobTerminal(updated.status)) {
      await clearPollAlarm();
    } else {
      await ensurePollAlarm();
    }
    return updated;
  } catch {
    return active;
  }
}

export async function startComponentGeneration(
  target: CodeTarget,
  evidence: ComponentEvidence,
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const startedAt = nowIso();

  try {
    const response = await fetch(`${API_BASE}/components`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, evidence }),
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { ok: false, error: (err as { error?: string }).error ?? 'Failed to start code generation.' };
    }

    const data = (await response.json()) as { jobId: string; status: ComponentJobStatus };
    const job: PersistedComponentJob = {
      jobId: data.jobId,
      sourceUrl: evidence.sourceUrl,
      target,
      status: data.status ?? 'QUEUED',
      startedAt,
      updatedAt: startedAt,
    };
    await setActiveComponentJob(job);
    await ensurePollAlarm();

    return { ok: true, jobId: data.jobId };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reach the Origami API.';
    return { ok: false, error: message };
  }
}

export async function getComponentJobState(): Promise<PersistedComponentJob | null> {
  const active = await getActiveComponentJob();
  if (!active) return null;
  if (isComponentJobInProgress(active.status)) {
    return refreshActiveComponentJob();
  }
  return active;
}

export async function clearActiveComponentJob(): Promise<void> {
  await clearPollAlarm();
  await setActiveComponentJob(null);
}

export function registerComponentAlarmListener(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === COMPONENT_POLL_ALARM) {
      refreshActiveComponentJob().catch(() => {});
    }
  });
}

export async function recoverComponentJobOnStartup(): Promise<void> {
  const active = await getActiveComponentJob();
  if (!active) return;
  if (isComponentJobInProgress(active.status)) {
    await ensurePollAlarm();
    await refreshActiveComponentJob();
  }
}
