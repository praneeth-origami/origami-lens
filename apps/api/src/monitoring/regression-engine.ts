/**
 * Continuous Monitoring's regression comparison engine (V3) — entirely
 * deterministic, never AI-driven (see monitoring-ask-service.ts's doc
 * comment: AI only EXPLAINS an event this engine already produced). Every
 * function here is a pure comparison of two already-persisted scans'
 * already-computed data (HealthScore, console/network evidence,
 * screenshots) — it never re-scores or re-evaluates anything itself.
 */
import type { ConsoleEntry, HealthScore, IssueCategory, MonitoringEventType, NetworkEntry, Severity } from '@origami/contracts';
import { CATEGORY_LABEL } from '@origami/contracts';
import type { ArtifactStore } from '../artifact-store.js';
import { compareScanScreenshots } from '../visual-comparison-service.js';

export interface RegressionEventDraft {
  eventType: MonitoringEventType;
  severity: Severity;
  title: string;
  description: string;
  previousValue?: unknown;
  currentValue?: unknown;
  metadata?: Record<string, unknown>;
}

/** Below this many points, a Health Score dip is ordinary day-to-day noise, not a regression worth alerting on — matches the roadmap's own "91 → 90 is probably nothing, 91 → 67 is a real regression" framing. Configurable because "major regression" is inherently a product/customer judgment call, not a derivable constant. */
const HEALTH_SCORE_DROP_THRESHOLD = Number(process.env.MONITORING_HEALTH_SCORE_DROP_THRESHOLD ?? 10);
/** Per-category thresholds are slightly more lenient than the overall score's — a single category naturally swings more than the blended overall score for the same number of new/fixed issues. */
const CATEGORY_SCORE_DROP_THRESHOLD = Number(process.env.MONITORING_CATEGORY_SCORE_DROP_THRESHOLD ?? 15);
/** Caps how many individual "New JavaScript error" / "New network error" events one scan can create — a deploy that breaks everything shouldn't flood monitoring_events with dozens of near-duplicate rows; the remainder is folded into one summary event instead. */
const MAX_NEW_ERROR_EVENTS = 5;

function severityForScoreDrop(drop: number): Severity {
  if (drop >= 40) return 'CRITICAL';
  if (drop >= 25) return 'HIGH';
  return 'MEDIUM';
}

/** A/B — Health Score (overall + per-category) regression. */
export function compareHealthScore(previous: HealthScore | undefined, current: HealthScore): RegressionEventDraft[] {
  if (!previous) return [];
  const events: RegressionEventDraft[] = [];

  const overallDrop = previous.overallScore - current.overallScore;
  if (overallDrop >= HEALTH_SCORE_DROP_THRESHOLD) {
    events.push({
      eventType: 'HEALTH_SCORE_DROP',
      severity: severityForScoreDrop(overallDrop),
      title: `Health Score dropped ${previous.overallScore} → ${current.overallScore}`,
      description: `The overall Health Score dropped by ${overallDrop.toFixed(1)} points, from ${previous.overallScore} to ${current.overallScore}, compared to the previous scan.`,
      previousValue: previous.overallScore,
      currentValue: current.overallScore,
      metadata: { drop: overallDrop },
    });
  }

  // D/E — Accessibility and Performance category regressions, from the
  // SAME HealthScore categories every scan already computes — never a
  // second scoring pass.
  const categoryEventTypes: Partial<Record<IssueCategory, MonitoringEventType>> = {
    accessibility: 'ACCESSIBILITY_REGRESSION',
    performance: 'PERFORMANCE_REGRESSION',
  };
  for (const [category, eventType] of Object.entries(categoryEventTypes) as [IssueCategory, MonitoringEventType][]) {
    const prevScore = previous.categories[category]?.score;
    const currScore = current.categories[category]?.score;
    if (prevScore === undefined || currScore === undefined) continue;
    const drop = prevScore - currScore;
    if (drop >= CATEGORY_SCORE_DROP_THRESHOLD) {
      events.push({
        eventType,
        severity: severityForScoreDrop(drop),
        title: `${CATEGORY_LABEL[category]} score dropped ${prevScore} → ${currScore}`,
        description: `${CATEGORY_LABEL[category]} score dropped by ${drop.toFixed(1)} points, from ${prevScore} to ${currScore}, compared to the previous scan.`,
        previousValue: prevScore,
        currentValue: currScore,
        metadata: { category, drop },
      });
    }
  }

  return events;
}

/** Strips volatile characters (line numbers, hex addresses, timestamps baked into a message) so the SAME underlying error keeps the SAME identity across days, instead of looking "new" every time a number inside it changes. */
function normalizeForIdentity(text: string): string {
  return text.replace(/0x[0-9a-f]+/gi, '#').replace(/\d+/g, '#').trim().slice(0, 300);
}

/** Stable identity: error type + normalized message + the shape of its first few stack frames (never raw line numbers, which shift between otherwise-identical deploys). */
function consoleErrorIdentity(entry: ConsoleEntry): string {
  const stackSignature = entry.stack
    ? entry.stack.split('\n').slice(0, 3).map(normalizeForIdentity).join('|')
    : '';
  return `${entry.type}:${normalizeForIdentity(entry.message)}:${stackSignature}`;
}

/** B — new JavaScript errors: present in the current scan's console evidence, absent (by stable identity) from the previous scan's. */
export function compareConsoleErrors(previous: ConsoleEntry[] | undefined, current: ConsoleEntry[], pageUrl: string): RegressionEventDraft[] {
  const relevant = (entries: ConsoleEntry[]) => entries.filter((e) => e.type === 'error' || e.type === 'exception');
  const previousIds = new Set(relevant(previous ?? []).map(consoleErrorIdentity));

  const seen = new Set<string>();
  const newErrors: ConsoleEntry[] = [];
  for (const entry of relevant(current)) {
    const id = consoleErrorIdentity(entry);
    if (previousIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    newErrors.push(entry);
  }
  if (newErrors.length === 0) return [];

  const events: RegressionEventDraft[] = newErrors.slice(0, MAX_NEW_ERROR_EVENTS).map((entry) => ({
    eventType: 'NEW_JAVASCRIPT_ERROR',
    severity: 'HIGH',
    title: `New JavaScript error: ${entry.message.slice(0, 120)}`,
    description: `A JavaScript error that was not present in the previous scan appeared on ${pageUrl}.`,
    previousValue: { occurrences: 0 },
    currentValue: { occurrences: 1, message: entry.message },
    metadata: { message: entry.message, stack: entry.stack, pageUrl, type: entry.type },
  }));

  const overflow = newErrors.length - MAX_NEW_ERROR_EVENTS;
  if (overflow > 0) {
    events.push({
      eventType: 'NEW_JAVASCRIPT_ERROR',
      severity: 'MEDIUM',
      title: `${overflow} more new JavaScript error${overflow === 1 ? '' : 's'}`,
      description: `${overflow} additional new JavaScript error${overflow === 1 ? '' : 's'} were detected on ${pageUrl} but are not individually listed.`,
      metadata: { truncated: true, count: overflow },
    });
  }
  return events;
}

/** Stable identity for a failed/erroring network request — method + path with numeric path segments normalized (so /api/users/123 and /api/users/456 are the same endpoint) + status. */
function networkErrorIdentity(entry: NetworkEntry): string {
  let pathname = entry.url;
  try {
    pathname = new URL(entry.url).pathname.replace(/\/\d+(?=\/|$)/g, '/#');
  } catch {
    // Not a parseable absolute URL — fall back to the raw string, still deterministic.
  }
  return `${entry.method}:${pathname}:${entry.status}`;
}

/** C — new network errors: a failed or 4xx/5xx request whose (method, normalized path, status) wasn't present in the previous scan. */
export function compareNetworkErrors(previous: NetworkEntry[] | undefined, current: NetworkEntry[], pageUrl: string): RegressionEventDraft[] {
  const relevant = (entries: NetworkEntry[]) => entries.filter((e) => e.failed || e.status >= 400);
  const previousIds = new Set(relevant(previous ?? []).map(networkErrorIdentity));

  const seen = new Set<string>();
  const newErrors: NetworkEntry[] = [];
  for (const entry of relevant(current)) {
    const id = networkErrorIdentity(entry);
    if (previousIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    newErrors.push(entry);
  }
  if (newErrors.length === 0) return [];

  const events: RegressionEventDraft[] = newErrors.slice(0, MAX_NEW_ERROR_EVENTS).map((entry) => ({
    eventType: 'NEW_NETWORK_ERROR',
    severity: entry.status >= 500 || entry.failed ? 'HIGH' : 'MEDIUM',
    title: `New network error: ${entry.method} ${entry.url} → ${entry.status}`,
    description: `A request that was not failing in the previous scan now fails on ${pageUrl}.`,
    previousValue: { occurrences: 0 },
    currentValue: { occurrences: 1, status: entry.status },
    metadata: { url: entry.url, method: entry.method, status: entry.status, pageUrl },
  }));

  const overflow = newErrors.length - MAX_NEW_ERROR_EVENTS;
  if (overflow > 0) {
    events.push({
      eventType: 'NEW_NETWORK_ERROR',
      severity: 'MEDIUM',
      title: `${overflow} more new network error${overflow === 1 ? '' : 's'}`,
      description: `${overflow} additional new network errors were detected on ${pageUrl} but are not individually listed.`,
      metadata: { truncated: true, count: overflow },
    });
  }
  return events;
}

/**
 * G — Visual regression, reusing the existing real pixel-diff service
 * (compareScanScreenshots) directly rather than building a second
 * comparison engine — see that file's own PIXELMATCH_THRESHOLD/
 * MEANINGFUL_CHANGE_PERCENT constants, unchanged and un-duplicated here.
 * V3 scope: the monitored site's ROOT page only (one screenshot per scan),
 * not every discovered page — a documented scoping choice, not a missing
 * feature; per-page visual diffing is a natural follow-up.
 *
 * `scanId` here is the composite `${scanId}/${pageScanId}` key
 * ArtifactStore already uses for a website page's screenshots (see
 * ScanRepository.getRootPageScanData's doc comment) — ownership is
 * presumed already verified by the caller (this only ever runs from the
 * monitoring worker, never from a client-facing route), so the injected
 * `isScanOwnedByOrganizations` always returns true here.
 */
export async function compareVisualRegression(
  artifactStore: Pick<ArtifactStore, 'readArtifactBase64'>,
  previous: { screenshotKey: string; hasDesktopScreenshot: boolean } | undefined,
  current: { screenshotKey: string; hasDesktopScreenshot: boolean },
): Promise<RegressionEventDraft | undefined> {
  if (!previous?.hasDesktopScreenshot || !current.hasDesktopScreenshot) return undefined;

  try {
    const result = await compareScanScreenshots(
      { isScanOwnedByOrganizations: async () => true },
      artifactStore,
      { beforeScanId: previous.screenshotKey, beforeArtifactKey: 'desktop.jpg', afterScanId: current.screenshotKey, afterArtifactKey: 'desktop.jpg' },
      [],
    );
    if (!result.meaningfulChange) return undefined;
    return {
      eventType: 'VISUAL_REGRESSION',
      severity: result.diffPercentage >= 15 ? 'HIGH' : 'MEDIUM',
      title: `Visual change detected (${result.diffPercentage.toFixed(1)}% of the page changed)`,
      description: `The page's appearance changed by ${result.diffPercentage.toFixed(1)}% compared to the previous scan's screenshot.`,
      metadata: { diffPercentage: result.diffPercentage, changedRegions: result.changedRegions },
    };
  } catch {
    // A missing/corrupt screenshot (e.g. this scan didn't capture one) is
    // never a reason to fail the whole regression pass — visual comparison
    // is additive, not load-bearing.
    return undefined;
  }
}
