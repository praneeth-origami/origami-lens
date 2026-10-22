import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { VisualComparisonError, compareScanScreenshots, type VisualComparisonStores } from './visual-comparison-service.js';
import type { ArtifactStore } from './artifact-store.js';

/** Synthesizes a small solid-color JPEG (RGBA input, jpeg-js ignores alpha on encode) — avoids needing binary fixture files checked into the repo. */
function makeSolidJpegBase64(width: number, height: number, rgb: [number, number, number]): string {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  const encoded = jpeg.encode({ width, height, data }, 90);
  return Buffer.from(encoded.data).toString('base64');
}

/** Same as makeSolidJpegBase64, but the right half of the image is a different color — a real, deterministic "half the page changed" fixture. */
function makeHalfChangedJpegBase64(width: number, height: number, leftRgb: [number, number, number], rightRgb: [number, number, number]): string {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const rgb = x < width / 2 ? leftRgb : rightRgb;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ width, height, data }, 90);
  return Buffer.from(encoded.data).toString('base64');
}

function fakeArtifactStore(byKey: Record<string, string>): Pick<ArtifactStore, 'readArtifactBase64'> {
  return { readArtifactBase64: (_scanId: string, key: string) => byKey[key] };
}

function ownedStores(owned: Set<string>): VisualComparisonStores {
  return { isScanOwnedByOrganizations: async (scanId) => owned.has(scanId) };
}

describe('compareScanScreenshots', () => {
  it('rejects when either scan is not owned by the caller\'s organizations, before ever reading artifacts', async () => {
    let called = false;
    const artifactStore = { readArtifactBase64: () => { called = true; return undefined; } };
    await assert.rejects(
      () => compareScanScreenshots(ownedStores(new Set(['scan-a'])), artifactStore, { beforeScanId: 'scan-a', beforeArtifactKey: 'desktop.jpg', afterScanId: 'scan-b', afterArtifactKey: 'desktop.jpg' }, ['org-1']),
      (error: unknown) => { assert.ok(error instanceof VisualComparisonError); assert.equal(error.code, 'SCAN_NOT_FOUND'); return true; },
    );
    assert.equal(called, false);
  });

  it('rejects when an artifact key does not resolve to a stored screenshot', async () => {
    const artifactStore = fakeArtifactStore({ 'before.jpg': makeSolidJpegBase64(4, 4, [255, 0, 0]) });
    await assert.rejects(
      () => compareScanScreenshots(ownedStores(new Set(['scan-a', 'scan-b'])), artifactStore, { beforeScanId: 'scan-a', beforeArtifactKey: 'before.jpg', afterScanId: 'scan-b', afterArtifactKey: 'missing.jpg' }, ['org-1']),
      (error: unknown) => { assert.ok(error instanceof VisualComparisonError); assert.equal(error.code, 'ARTIFACT_NOT_FOUND'); return true; },
    );
  });

  it('rejects two screenshots of different dimensions rather than silently comparing them', async () => {
    const artifactStore = fakeArtifactStore({
      'before.jpg': makeSolidJpegBase64(8, 8, [255, 0, 0]),
      'after.jpg': makeSolidJpegBase64(16, 16, [255, 0, 0]),
    });
    await assert.rejects(
      () => compareScanScreenshots(ownedStores(new Set(['scan-a', 'scan-b'])), artifactStore, { beforeScanId: 'scan-a', beforeArtifactKey: 'before.jpg', afterScanId: 'scan-b', afterArtifactKey: 'after.jpg' }, ['org-1']),
      (error: unknown) => { assert.ok(error instanceof VisualComparisonError); assert.equal(error.code, 'DIMENSION_MISMATCH'); return true; },
    );
  });

  it('reports meaningfulChange: false and ~0% diff for two identical screenshots', async () => {
    const jpegBase64 = makeSolidJpegBase64(32, 32, [40, 120, 200]);
    const artifactStore = fakeArtifactStore({ 'before.jpg': jpegBase64, 'after.jpg': jpegBase64 });

    const result = await compareScanScreenshots(ownedStores(new Set(['scan-a', 'scan-b'])), artifactStore, { beforeScanId: 'scan-a', beforeArtifactKey: 'before.jpg', afterScanId: 'scan-b', afterArtifactKey: 'after.jpg' }, ['org-1']);

    assert.equal(result.meaningfulChange, false);
    assert.ok(result.diffPercentage < 0.5);
    assert.deepEqual(result.changedRegions, []);
    assert.equal(result.beforeImageUrl, '/scans/scan-a/artifacts/before.jpg');
    assert.equal(result.afterImageUrl, '/scans/scan-b/artifacts/after.jpg');
  });

  it('reports meaningfulChange: true, a real diffPercentage, and changedRegions clustered on the side that actually changed', async () => {
    const artifactStore = fakeArtifactStore({
      'before.jpg': makeSolidJpegBase64(64, 64, [255, 255, 255]),
      'after.jpg': makeHalfChangedJpegBase64(64, 64, [255, 255, 255], [10, 10, 10]),
    });

    const result = await compareScanScreenshots(ownedStores(new Set(['scan-a', 'scan-b'])), artifactStore, { beforeScanId: 'scan-a', beforeArtifactKey: 'before.jpg', afterScanId: 'scan-b', afterArtifactKey: 'after.jpg' }, ['org-1']);

    assert.equal(result.meaningfulChange, true);
    assert.ok(result.diffPercentage > 30, `expected roughly half the pixels to differ, got ${result.diffPercentage}%`);
    assert.ok(result.changedRegions.length > 0);
    // Every reported region should be on the right half (x >= 32), where the actual change is.
    assert.ok(result.changedRegions.every((r) => r.x >= 32));

    // The diff image must be a real, decodable PNG.
    const png = PNG.sync.read(Buffer.from(result.diffImageBase64, 'base64'));
    assert.equal(png.width, 64);
    assert.equal(png.height, 64);
  });
});
