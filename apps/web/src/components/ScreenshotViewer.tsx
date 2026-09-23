import { useState } from 'react';
import type { ScanArtifacts } from '@origami/contracts';
import { Disclosure } from './Disclosure';

interface Props {
  scanId: string;
  artifacts?: ScanArtifacts;
}

export function ScreenshotViewer({ scanId, artifacts }: Props) {
  const shots = artifacts?.screenshots ?? [];
  const [active, setActive] = useState(shots[0]?.viewport ?? 'desktop');

  // No empty placeholder — a scan with no captured screenshots simply
  // doesn't show a screenshots section at all.
  if (shots.length === 0) return null;

  const current = shots.find((s) => s.viewport === active) ?? shots[0];

  return (
    <Disclosure title="Screenshots" meta={`${shots.length} viewport${shots.length === 1 ? '' : 's'}`}>
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
    </Disclosure>
  );
}
