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
}
