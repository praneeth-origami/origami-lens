import { useState } from 'react';
import type { ScanArtifacts } from '@origami/contracts';

interface Props {
  scanId: string;
  artifacts?: ScanArtifacts;
}

export function ScreenshotViewer({ scanId, artifacts }: Props) {
  const shots = artifacts?.screenshots ?? [];
  const [active, setActive] = useState(shots[0]?.viewport ?? 'desktop');

  if (shots.length === 0) {
    return (
      <section className="screenshot-viewer empty">
        <h3>Page Screenshots</h3>
        <p className="muted">No screenshots captured for this scan.</p>
      </section>
    );
  }

  const current = shots.find((s) => s.viewport === active) ?? shots[0];

  return (
    <section className="screenshot-viewer">
      <h3>Page Screenshots</h3>
      <div className="screenshot-tabs">
        {shots.map((s) => (
          <button
            key={s.viewport}
            type="button"
            className={active === s.viewport ? 'active' : ''}
            onClick={() => setActive(s.viewport)}
          >
            {s.viewport === 'desktop' ? 'Desktop' : 'Mobile'}
          </button>
        ))}
      </div>
      <img
        src={`/api/scans/${scanId}/artifacts/${current.storageKey}`}
        alt={`${current.viewport} screenshot`}
        className="screenshot-image"
        width={current.width}
        height={current.height}
      />
    </section>
  );
}
