import { useEffect, useState } from 'react';
import type { ScanListItem, VisualComparisonResult } from '@origami/contracts';
import { ApiRequestError, compareScanScreenshots, fetchScans } from '../api/client';

interface Props {
  url: string;
  /** Pre-selected as the "After" scan — typically the scan/page currently being viewed. */
  currentScanId: string;
}

type ViewMode = 'side-by-side' | 'overlay' | 'diff';

/**
 * "Visual Comparison" (roadmap Phase 5) — real pixel-diffing between two
 * existing scans' screenshots of the SAME url, reusing the existing
 * screenshot/artifact infrastructure end to end (no new upload mechanism).
 * The "Before" candidate list is every other scan of this exact url,
 * reusing the existing scans list (fetchScans) rather than a new endpoint.
 */
export function VisualComparisonPanel({ url, currentScanId }: Props) {
  const [candidates, setCandidates] = useState<ScanListItem[]>([]);
  const [beforeScanId, setBeforeScanId] = useState('');
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [viewMode, setViewMode] = useState<ViewMode>('side-by-side');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<VisualComparisonResult | null>(null);

  useEffect(() => {
    fetchScans()
      .then(({ scans }) => {
        const sameUrl = scans.filter((s) => s.url === url && s.scanId !== currentScanId);
        setCandidates(sameUrl);
        if (sameUrl.length > 0) setBeforeScanId(sameUrl[0]!.scanId);
      })
      .catch(() => setCandidates([]));
  }, [url, currentScanId]);

  const compare = async () => {
    if (!beforeScanId) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const comparison = await compareScanScreenshots(beforeScanId, currentScanId, viewport);
      setResult(comparison);
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.code === 'DIMENSION_MISMATCH'
          ? err.message
          : err instanceof ApiRequestError && err.code === 'ARTIFACT_NOT_FOUND'
            ? `One of these scans doesn't have a ${viewport} screenshot to compare.`
            : 'Visual comparison failed.',
      );
    } finally {
      setLoading(false);
    }
  };

  if (candidates.length === 0) {
    return null;
  }

  return (
    <section className="ai-section visual-comparison-panel">
      <div className="ai-section-heading">
        <div>
          <h3>Visual Comparison</h3>
          <p className="muted">Compare this scan's screenshot against a previous scan of the same page — useful for release verification and regression checks.</p>
        </div>
      </div>

      <div className="visual-comparison-controls">
        <label>
          Before
          <select value={beforeScanId} onChange={(e) => setBeforeScanId(e.target.value)}>
            {candidates.map((c) => (
              <option key={c.scanId} value={c.scanId}>{new Date(c.scannedAt).toLocaleString()}</option>
            ))}
          </select>
        </label>
        <label>
          Viewport
          <select value={viewport} onChange={(e) => setViewport(e.target.value as 'desktop' | 'mobile')}>
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile</option>
          </select>
        </label>
        <button type="button" className="primary-button" onClick={compare} disabled={loading}>
          {loading ? 'Comparing…' : 'Compare'}
        </button>
      </div>

      {error && <p className="ai-response ai-response-error">{error}</p>}

      {result && (
        <div className="visual-comparison-result">
          <div className="visual-comparison-summary">
            <span className={`responsive-viewport-count ${result.meaningfulChange ? 'has-issues' : 'ok'}`}>
              {result.diffPercentage}% different
            </span>
            {!result.meaningfulChange && <span className="muted">No meaningful visual change detected.</span>}
          </div>

          <div className="visual-comparison-tabs">
            {(['side-by-side', 'overlay', 'diff'] as ViewMode[]).map((mode) => (
              <button key={mode} type="button" className={`ol-secondary${viewMode === mode ? ' active' : ''}`} onClick={() => setViewMode(mode)}>
                {mode === 'side-by-side' ? 'Side by Side' : mode === 'overlay' ? 'Overlay' : 'Difference'}
              </button>
            ))}
          </div>

          {viewMode === 'side-by-side' && (
            <div className="visual-comparison-images">
              <figure><img src={`/api${result.beforeImageUrl}`} alt="Before" /><figcaption>Before</figcaption></figure>
              <figure><img src={`/api${result.afterImageUrl}`} alt="After" /><figcaption>After</figcaption></figure>
            </div>
          )}

          {viewMode === 'overlay' && (
            <div className="visual-comparison-overlay">
              <img src={`/api${result.afterImageUrl}`} alt="After" />
              {result.changedRegions.map((r, i) => (
                <div
                  key={i}
                  className="visual-comparison-region"
                  style={{ left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` }}
                />
              ))}
            </div>
          )}

          {viewMode === 'diff' && (
            <div className="visual-comparison-images">
              <figure><img src={`data:image/png;base64,${result.diffImageBase64}`} alt="Visual difference" /><figcaption>Visual Difference</figcaption></figure>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
