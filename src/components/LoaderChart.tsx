import { useState } from 'react';
import { familyLoaderCounts, fmt, type FamilyEntry, type Loader } from '../lib/data';

const LOADER_LABEL: Record<Loader, string> = {
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
};
/** Display order: Quilt sits beside Fabric (its closest relative). */
const DISPLAY_ORDER: Loader[] = ['fabric', 'quilt', 'forge', 'neoforge'];
const loaderVar = (l: Loader) => `var(--${l === 'neoforge' ? 'neo' : l})`;

/** Horizontal 100%-stacked share of mod counts per loader, newest family first. */
export default function LoaderChart({ families }: { families: FamilyEntry[] }) {
  const [tip, setTip] = useState<string | null>(null);
  const rows = [...families]
    .reverse()
    .map((f) => {
      const loaders = familyLoaderCounts(f);
      const counts = DISPLAY_ORDER.map((l) => ({ l, n: loaders[l] }));
      return { key: f.key, counts, sum: counts.reduce((a, c) => a + c.n, 0) };
    })
    .filter((r) => r.sum > 0);

  return (
    <div>
      <div className="legend" style={{ marginBottom: 18 }}>
        {DISPLAY_ORDER.map((l) => (
          <span key={l}><i style={{ background: loaderVar(l) }} />{LOADER_LABEL[l]}</span>
        ))}
      </div>
      <div className="hbars scroll">
        {rows.map((r) => (
          <div className="hrow" key={r.key}>
            <span className="lbl">{r.key}</span>
            <div className="track">
              {r.counts.filter((c) => c.n > 0).map((c) => (
                <i
                  key={c.l}
                  style={{ background: loaderVar(c.l), width: `${(c.n / r.sum) * 100}%` }}
                  title={`${LOADER_LABEL[c.l]} · ${fmt(c.n)} mods (${Math.round((c.n / r.sum) * 100)}%)`}
                  onMouseEnter={() => setTip(`${r.key}: ${LOADER_LABEL[c.l]} ${Math.round((c.n / r.sum) * 100)}% (${fmt(c.n)} mods)`)}
                  onMouseLeave={() => setTip(null)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="note" style={{ marginTop: 14, minHeight: 20 }}>
        {tip ?? 'Hover a segment for exact numbers. A mod can count toward several loaders.'}
      </div>
    </div>
  );
}
