import { useEffect, useState } from 'react';
import { AverageView } from './components/AverageView';
import { Timeline } from './components/Timeline';
import { useStore } from './store';
import type { Manifest } from './types';

export function App() {
  const setManifest = useStore((s) => s.setManifest);
  const manifest = useStore((s) => s.manifest);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/photos.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`photos.json not found (${r.status})`);
        return r.json() as Promise<Manifest>;
      })
      .then(setManifest)
      .catch((e) => setLoadError(String(e.message ?? e)));
  }, [setManifest]);

  if (loadError) {
    return (
      <div className="empty-state">
        <h1>No photo data yet</h1>
        <p>{loadError}</p>
        <p>
          Run <code>python scripts/preprocess.py /path/to/your/photos</code> from the project folder, then reload.
        </p>
      </div>
    );
  }

  return (
    <div className="app">
      <Header />
      <main className="stage">{manifest && <AverageView />}</main>
      <footer className="bottom">
        <Timeline />
      </footer>
    </div>
  );
}

function Header() {
  const photos = useStore((s) => s.photos);
  const selected = useStore((s) => s.selected);
  const range = useStore((s) => s.range);
  const snap = useStore((s) => s.snap);
  const setSnap = useStore((s) => s.setSnap);
  const linear = useStore((s) => s.linear);
  const setLinear = useStore((s) => s.setLinear);
  const fileDated = photos.filter((p) => p.dateSource === 'file').length;

  return (
    <header className="header">
      <div>
        <h1>Photo average</h1>
        <p className="subtitle">
          {selected.length} of {photos.length} photos · {describeRange(range)}
          {fileDated > 0 && <span className="muted"> · {fileDated} dated by file time (no EXIF)</span>}
        </p>
      </div>
      <div className="controls">
        <div className="segmented" role="group" aria-label="Brush snaps to">
          <span className="label">Snap</span>
          {(['year', 'month'] as const).map((s) => (
            <button key={s} className={snap === s ? 'active' : ''} onClick={() => setSnap(s)}>
              {s === 'year' ? 'Year' : 'Month'}
            </button>
          ))}
        </div>
        <label className="toggle" title="Average light intensities (gamma-decoded) instead of raw pixel values; usually a little brighter">
          <input type="checkbox" checked={linear} onChange={(e) => setLinear(e.target.checked)} />
          Linear-light average
        </label>
      </div>
    </header>
  );
}

function describeRange(range: [number, number] | null): string {
  if (!range) return 'all dates';
  const s = new Date(range[0]);
  const e = new Date(range[1] - 1);
  const wholeYears = s.getMonth() === 0 && s.getDate() === 1 && e.getMonth() === 11 && e.getDate() === 31;
  if (wholeYears) return s.getFullYear() === e.getFullYear() ? `${s.getFullYear()}` : `${s.getFullYear()}–${e.getFullYear()}`;
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  return fmt(s) === fmt(e) ? fmt(s) : `${fmt(s)} – ${fmt(e)}`;
}
