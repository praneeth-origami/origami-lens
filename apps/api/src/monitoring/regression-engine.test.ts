import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConsoleEntry, HealthScore, NetworkEntry } from '@origami/contracts';
import { compareConsoleErrors, compareHealthScore, compareNetworkErrors, compareVisualRegression } from './regression-engine.js';

function fakeHealthScore(overallScore: number, overrides: Partial<Record<keyof HealthScore['categories'], number>> = {}): HealthScore {
  const base = (score: number) => ({ score, weight: 100 / 7 });
  return {
    overallScore,
    categories: {
      functional: base(overrides.functional ?? overallScore),
      performance: base(overrides.performance ?? overallScore),
      visualMobile: base(overrides.visualMobile ?? overallScore),
      accessibility: base(overrides.accessibility ?? overallScore),
      bestPractices: base(overrides.bestPractices ?? overallScore),
      seo: base(overrides.seo ?? overallScore),
      securityHygiene: base(overrides.securityHygiene ?? overallScore),
    },
  };
}

describe('compareHealthScore', () => {
  it('creates no event when there is no previous scan (first/baseline scan)', () => {
    assert.deepEqual(compareHealthScore(undefined, fakeHealthScore(91)), []);
  });

  it('creates no event for a small, ordinary dip below the threshold', () => {
    const events = compareHealthScore(fakeHealthScore(91), fakeHealthScore(90));
    assert.deepEqual(events, []);
  });

  it('creates a HEALTH_SCORE_DROP event for a major drop, with before/after values', () => {
    // Every category drops uniformly here, so the per-category checks also
    // legitimately fire alongside it — this test only asserts the overall
    // HEALTH_SCORE_DROP event itself is correct.
    const events = compareHealthScore(fakeHealthScore(91), fakeHealthScore(67));
    const overall = events.find((e) => e.eventType === 'HEALTH_SCORE_DROP');
    assert.ok(overall);
    assert.equal(overall.previousValue, 91);
    assert.equal(overall.currentValue, 67);
    assert.match(overall.title, /91.*67/);
  });

  it('scales severity with the magnitude of the drop', () => {
    const medium = compareHealthScore(fakeHealthScore(91), fakeHealthScore(78))[0]; // drop 13
    const high = compareHealthScore(fakeHealthScore(91), fakeHealthScore(60))[0]; // drop 31
    const critical = compareHealthScore(fakeHealthScore(91), fakeHealthScore(40))[0]; // drop 51
    assert.equal(medium.severity, 'MEDIUM');
    assert.equal(high.severity, 'HIGH');
    assert.equal(critical.severity, 'CRITICAL');
  });

  it('creates an ACCESSIBILITY_REGRESSION event when only the accessibility category drops significantly', () => {
    const previous = fakeHealthScore(85, { accessibility: 85 });
    const current = fakeHealthScore(85, { accessibility: 60 }); // overall unchanged, accessibility dropped 25
    const events = compareHealthScore(previous, current);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'ACCESSIBILITY_REGRESSION');
  });

  it('creates a PERFORMANCE_REGRESSION event when only the performance category drops significantly', () => {
    const previous = fakeHealthScore(85, { performance: 85 });
    const current = fakeHealthScore(85, { performance: 55 });
    const events = compareHealthScore(previous, current);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'PERFORMANCE_REGRESSION');
  });
});

function consoleError(message: string, stack?: string): ConsoleEntry {
  return { type: 'error', message, timestamp: Date.now(), stack };
}

describe('compareConsoleErrors', () => {
  it('creates no event when there is no new error', () => {
    const previous = [consoleError('TypeError: x is not defined', 'at foo (app.js:10:5)')];
    const current = [consoleError('TypeError: x is not defined', 'at foo (app.js:10:5)')];
    assert.deepEqual(compareConsoleErrors(previous, current, 'https://example.com'), []);
  });

  it('does NOT treat the same error with a different line number as new (bugfix: avoid alert fatigue on the same recurring error)', () => {
    const previous = [consoleError('Cannot read property x of undefined', 'at foo (app.js:10:5)')];
    const current = [consoleError('Cannot read property x of undefined', 'at foo (app.js:14:9)')];
    assert.deepEqual(compareConsoleErrors(previous, current, 'https://example.com'), []);
  });

  it('creates a NEW_JAVASCRIPT_ERROR event for a genuinely new error', () => {
    const previous: ConsoleEntry[] = [];
    const current = [consoleError('TypeError: cart is undefined', 'at checkout (checkout.js:42:3)')];
    const events = compareConsoleErrors(previous, current, 'https://example.com/checkout');
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'NEW_JAVASCRIPT_ERROR');
    assert.equal(events[0].severity, 'HIGH');
    assert.match(events[0].title, /cart is undefined/);
    assert.equal((events[0].metadata as { pageUrl: string }).pageUrl, 'https://example.com/checkout');
  });

  it('ignores non-error console entries (log/warn)', () => {
    const current: ConsoleEntry[] = [{ type: 'log', message: 'debug info', timestamp: Date.now() }];
    assert.deepEqual(compareConsoleErrors([], current, 'https://example.com'), []);
  });

  it('caps individual events and folds the remainder into one summary event', () => {
    // Distinct words, not just a trailing digit — identity normalization
    // intentionally collapses purely-numeric differences (see the test
    // above), so these need to differ in substance to count as 8 distinct errors.
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    const current = words.map((w) => consoleError(`Unique ${w} failure`));
    const events = compareConsoleErrors([], current, 'https://example.com');
    assert.equal(events.length, 6); // 5 individual + 1 summary
    assert.equal(events[5].metadata?.truncated, true);
  });
});

function networkError(url: string, status: number): NetworkEntry {
  return { url, method: 'GET', status, duration: 100, resourceType: 'fetch', failed: status >= 500 };
}

describe('compareNetworkErrors', () => {
  it('creates no event when there is no new network failure', () => {
    const previous = [networkError('https://example.com/api/users/1', 404)];
    const current = [networkError('https://example.com/api/users/2', 404)]; // same endpoint shape, different id
    assert.deepEqual(compareNetworkErrors(previous, current, 'https://example.com'), []);
  });

  it('creates a NEW_NETWORK_ERROR event for a genuinely new failing endpoint', () => {
    const events = compareNetworkErrors([], [networkError('https://example.com/api/checkout', 500)], 'https://example.com/checkout');
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'NEW_NETWORK_ERROR');
    assert.equal(events[0].severity, 'HIGH');
  });

  it('ignores successful requests', () => {
    const current = [networkError('https://example.com/api/ok', 200)];
    assert.deepEqual(compareNetworkErrors([], current, 'https://example.com'), []);
  });
});

describe('compareVisualRegression', () => {
  it('returns undefined when either scan has no desktop screenshot', async () => {
    const result = await compareVisualRegression({ readArtifactBase64: () => undefined }, undefined, { screenshotKey: 'a', hasDesktopScreenshot: false });
    assert.equal(result, undefined);
  });

  it('returns undefined (never throws) when the screenshot artifact is missing on disk', async () => {
    const result = await compareVisualRegression(
      { readArtifactBase64: () => undefined },
      { screenshotKey: 'before', hasDesktopScreenshot: true },
      { screenshotKey: 'after', hasDesktopScreenshot: true },
    );
    assert.equal(result, undefined);
  });
});
