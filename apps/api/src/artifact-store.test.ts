import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactStore } from './artifact-store.js';

describe('ArtifactStore', () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (originalDataDir !== undefined) {
      process.env.SCAN_DATA_DIR = originalDataDir;
    } else {
      delete process.env.SCAN_DATA_DIR;
    }
  });

  it('saves screenshots and reads them back', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-artifacts-'));
    originalDataDir = process.env.SCAN_DATA_DIR;
    process.env.SCAN_DATA_DIR = tmpDir;

    const store = new ArtifactStore();
    const scanId = 'test-scan-123';
    const pngBase64 = Buffer.from('fake-jpeg-bytes').toString('base64');

    const stored = store.saveScreenshots(scanId, [
      { viewport: 'desktop', width: 1280, height: 720, base64: pngBase64 },
      { viewport: 'mobile', width: 390, height: 844, base64: pngBase64 },
    ]);

    assert.equal(stored.length, 2);
    assert.equal(stored[0].storageKey, 'desktop.jpg');
    assert.equal(stored[1].storageKey, 'mobile.jpg');

    const filePath = store.getArtifactPath(scanId, 'desktop.jpg');
    assert.ok(filePath);
    assert.ok(fs.existsSync(filePath!));

    const readBack = store.readArtifactBase64(scanId, 'desktop.jpg');
    assert.equal(readBack, pngBase64);
  });

  it('returns undefined for missing artifact', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-artifacts-'));
    originalDataDir = process.env.SCAN_DATA_DIR;
    process.env.SCAN_DATA_DIR = tmpDir;

    const store = new ArtifactStore();
    assert.equal(store.getArtifactPath('missing', 'desktop.jpg'), undefined);
  });
});
