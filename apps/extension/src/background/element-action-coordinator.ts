/// <reference types="chrome" />
import { API_BASE } from '../types/scan.js';
import type { ComponentEvidence, ElementActionType } from '@origami/contracts';

/**
 * Runs one "Select Anything" element action (Explain/Fix/Improve/Make
 * Responsive) against the selected element's evidence — POST /elements/actions,
 * same request/response shape apps/api's route expects. Unlike
 * startComponentGeneration (a queued code-generation job the popup polls),
 * this is a single synchronous request: the content script shows the answer
 * directly, no job/polling state needed. Never sends a repositoryId today —
 * the selection overlay has no repository picker yet, so every action from
 * here is browser-only (see element-action-service.ts's fallback posture,
 * which already explains this the same way when a repository IS supplied
 * but isn't ready).
 */
export async function runElementAction(
  action: ElementActionType,
  evidence: ComponentEvidence,
  instruction?: string,
): Promise<{ ok: boolean; answer?: string; groundedInRepository?: boolean; error?: string }> {
  try {
    const response = await fetch(`${API_BASE}/elements/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, evidence, instruction }),
      signal: AbortSignal.timeout(70_000),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { ok: false, error: (err as { error?: string }).error ?? 'Could not complete this action.' };
    }

    const data = (await response.json()) as { answer: string; groundedInRepository: boolean };
    return { ok: true, answer: data.answer, groundedInRepository: data.groundedInRepository };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to reach the Origami API.' };
  }
}
