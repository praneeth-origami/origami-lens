import type { ScreenshotEvidence } from '@origami/contracts';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DATA_DIR = process.env.SCAN_DATA_DIR ?? path.join(process.cwd(), '.origami-data');
const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts');

export interface StoredScreenshot {
  viewport: 'desktop' | 'mobile';
  storageKey: string;
  width: number;
  height: number;
}

export class ArtifactStore {
  private artifactsRoot = ARTIFACTS_DIR;

  saveScreenshots(scanId: string, screenshots: ScreenshotEvidence[]): StoredScreenshot[] {
    const scanDir = path.join(this.artifactsRoot, scanId);
    fs.mkdirSync(scanDir, { recursive: true });

    const stored: StoredScreenshot[] = [];

    for (const shot of screenshots) {
      if (!shot.base64) continue;

      const storageKey = `${shot.viewport}.jpg`;
      const filePath = path.join(scanDir, storageKey);
      fs.writeFileSync(filePath, Buffer.from(shot.base64, 'base64'));

      stored.push({
        viewport: shot.viewport,
        storageKey,
        width: shot.width,
        height: shot.height,
      });
    }

    return stored;
  }

  /** Generic single-image save, reusing the exact same on-disk layout saveScreenshots already uses — `id` need not be a scan id (Create Bug Report uses it keyed by bugReportId). */
  saveImage(id: string, key: string, base64: string): void {
    const dir = path.join(this.artifactsRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, path.basename(key)), Buffer.from(base64, 'base64'));
  }

  getArtifactPath(scanId: string, key: string): string | undefined {
    const safeKey = path.basename(key);
    const filePath = path.join(this.artifactsRoot, scanId, safeKey);
    if (!fs.existsSync(filePath)) return undefined;
    return filePath;
  }

  readArtifactBase64(scanId: string, key: string): string | undefined {
    const filePath = this.getArtifactPath(scanId, key);
    if (!filePath) return undefined;
    return fs.readFileSync(filePath).toString('base64');
  }

  /** Removes every screenshot saved for a scan — called after the scan's own DB row is deleted, so a deleted scan doesn't leave its screenshots orphaned on disk forever. A no-op (never throws) if the scan never had any artifacts. */
  deleteScanArtifacts(scanId: string): void {
    const scanDir = path.join(this.artifactsRoot, scanId);
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
}
