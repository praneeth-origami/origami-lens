import type { ChangedRegion, VisualComparisonErrorCode, VisualComparisonResult } from '@origami/contracts';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import type { ArtifactStore } from './artifact-store.js';

export class VisualComparisonError extends Error {
  constructor(message: string, public readonly code: VisualComparisonErrorCode) {
    super(message);
    this.name = 'VisualComparisonError';
  }
}

/** Per-pixel color-difference sensitivity pixelmatch uses to decide "different" (0 = every pixel counts, 1 = nothing does) — 0.1 is pixelmatch's own documented default and matches typical screenshot-diff usage (anti-aliasing/compression noise tolerant, real layout/color changes still caught). */
const PIXELMATCH_THRESHOLD = 0.1;
/** Below this overall diff percentage, two screenshots are treated as "no meaningful change" (e.g. imperceptible JPEG re-encoding noise) rather than a real regression — same posture as a visual-regression CI gate's tolerance. */
const MEANINGFUL_CHANGE_PERCENT = 0.5;
/** Coarse grid resolution for changedRegions — real screenshots are large (often 1280x720+); reporting a bounding box per grid cell that contains enough diff pixels is honest (never invented) without requiring full connected-component clustering. */
const REGION_GRID_SIZE = 8;
/** A grid cell only counts as "changed" once at least this fraction of its pixels actually differ — filters out a handful of stray anti-aliasing pixels from being reported as a whole-cell region. */
const REGION_MIN_DENSITY = 0.02;

interface DecodedImage {
  width: number;
  height: number;
  data: Buffer;
}

function decodeJpegBase64(base64: string, label: 'before' | 'after'): DecodedImage {
  try {
    const raw = jpeg.decode(Buffer.from(base64, 'base64'), { useTArray: true });
    return { width: raw.width, height: raw.height, data: Buffer.from(raw.data) };
  } catch (error) {
    throw new VisualComparisonError(`Could not decode the ${label} screenshot: ${error instanceof Error ? error.message : 'invalid image data'}`, 'COMPARISON_FAILED');
  }
}

function detectChangedRegions(diff: Buffer, width: number, height: number): ChangedRegion[] {
  const cellWidth = Math.ceil(width / REGION_GRID_SIZE);
  const cellHeight = Math.ceil(height / REGION_GRID_SIZE);
  const regions: ChangedRegion[] = [];

  for (let cellY = 0; cellY < REGION_GRID_SIZE; cellY++) {
    for (let cellX = 0; cellX < REGION_GRID_SIZE; cellX++) {
      const x0 = cellX * cellWidth;
      const y0 = cellY * cellHeight;
      const x1 = Math.min(x0 + cellWidth, width);
      const y1 = Math.min(y0 + cellHeight, height);
      if (x0 >= width || y0 >= height) continue;

      let diffCount = 0;
      const cellArea = (x1 - x0) * (y1 - y0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const alphaIndex = (y * width + x) * 4 + 3;
          if (diff[alphaIndex] > 0) diffCount++;
        }
      }

      if (cellArea > 0 && diffCount / cellArea >= REGION_MIN_DENSITY) {
        regions.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      }
    }
  }

  return regions;
}

/**
 * Real pixel-diffing (pixelmatch) between two decoded, equal-dimension
 * screenshots — never a fabricated/heuristic-only result. Throws
 * DIMENSION_MISMATCH rather than resizing/cropping to force a comparison,
 * since that would silently compare content that was never actually
 * rendered at the same size (e.g. a desktop-vs-mobile screenshot pair).
 */
function diffImages(before: DecodedImage, after: DecodedImage): { diffImageBase64: string; diffPercentage: number; changedRegions: ChangedRegion[] } {
  if (before.width !== after.width || before.height !== after.height) {
    throw new VisualComparisonError(
      `The before (${before.width}x${before.height}) and after (${after.width}x${after.height}) screenshots have different dimensions and cannot be compared pixel-for-pixel — compare screenshots from the same viewport.`,
      'DIMENSION_MISMATCH',
    );
  }

  const { width, height } = before;
  const diff = Buffer.alloc(width * height * 4);
  let numDiffPixels: number;
  try {
    numDiffPixels = pixelmatch(before.data, after.data, diff, width, height, { threshold: PIXELMATCH_THRESHOLD, diffMask: true });
  } catch (error) {
    throw new VisualComparisonError(error instanceof Error ? error.message : 'Image comparison failed.', 'COMPARISON_FAILED');
  }

  const diffPercentage = Math.round(((numDiffPixels / (width * height)) * 100) * 100) / 100;
  const changedRegions = detectChangedRegions(diff, width, height);

  const png = new PNG({ width, height });
  diff.copy(png.data);
  const diffImageBase64 = PNG.sync.write(png).toString('base64');

  return { diffImageBase64, diffPercentage, changedRegions };
}

export interface VisualComparisonStores {
  /** Returns undefined for "doesn't exist or isn't yours" (generic 404) — same convention every other organization-scoped scan lookup already uses. */
  isScanOwnedByOrganizations(scanId: string, organizationIds: string[]): Promise<boolean>;
}

/**
 * Orchestrates Visual Comparison (roadmap Phase 5): verifies both scans
 * belong to the caller, reads both screenshots via the EXISTING
 * ArtifactStore (never a new upload/storage mechanism), decodes them, and
 * runs a real pixel diff. Before/after are referenced by their EXISTING
 * artifact URLs (GET /scans/:scanId/artifacts/:key) — the caller (index.ts)
 * builds those, this function only returns the keys' relative paths.
 */
export async function compareScanScreenshots(
  stores: VisualComparisonStores,
  artifactStore: Pick<ArtifactStore, 'readArtifactBase64'>,
  request: { beforeScanId: string; beforeArtifactKey: string; afterScanId: string; afterArtifactKey: string },
  organizationIds: string[],
): Promise<VisualComparisonResult> {
  const [beforeOwned, afterOwned] = await Promise.all([
    stores.isScanOwnedByOrganizations(request.beforeScanId, organizationIds),
    stores.isScanOwnedByOrganizations(request.afterScanId, organizationIds),
  ]);
  if (!beforeOwned || !afterOwned) {
    throw new VisualComparisonError('Scan not found.', 'SCAN_NOT_FOUND');
  }

  const beforeBase64 = artifactStore.readArtifactBase64(request.beforeScanId, request.beforeArtifactKey);
  const afterBase64 = artifactStore.readArtifactBase64(request.afterScanId, request.afterArtifactKey);
  if (!beforeBase64 || !afterBase64) {
    throw new VisualComparisonError('One or both screenshots could not be found.', 'ARTIFACT_NOT_FOUND');
  }

  const before = decodeJpegBase64(beforeBase64, 'before');
  const after = decodeJpegBase64(afterBase64, 'after');
  const { diffImageBase64, diffPercentage, changedRegions } = diffImages(before, after);

  return {
    beforeImageUrl: `/scans/${request.beforeScanId}/artifacts/${request.beforeArtifactKey}`,
    afterImageUrl: `/scans/${request.afterScanId}/artifacts/${request.afterArtifactKey}`,
    diffImageBase64,
    diffPercentage,
    changedRegions,
    meaningfulChange: diffPercentage >= MEANINGFUL_CHANGE_PERCENT,
  };
}
