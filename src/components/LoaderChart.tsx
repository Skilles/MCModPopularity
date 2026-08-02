import { useState } from 'react';
import { fmt, LOADERS, type FamilyEntry, type Loader } from '../lib/data';

const LOADER_LABEL: Record<Loader, string> = {
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
};

/** Horizontal 100%-stacked share of mod counts per loader, newest families last. */
export default function LoaderChart({ families }: { families: FamilyEntry[] }) {
  const recent = families.slice(-8);
  const [tip, setTip] = useState<string | null>(null);

  return (
    <div>
      <div className="legend" style={{ marginBottom: 16 }}>
        {LOADERS.map((l) => (
          <span key={l}><i style={{ background: `var(--${l === 'neoforge' ? 'neo' : l})` }} />{LOADER_LABEL[l]}</span>
        ))}
      </div>
      <div className="hbars">
        {recent.map((f) => {
          const counts = LOADERS.map((l) => ({ l, n: f.cf.loaders[l] + f.mr.loaders[l] }));
          const sum = counts.reduce((a, c) => a + c.n, 0);
          if (sum === 0) return null;
          return (
            <div className="hrow" key={f.key}>
              <span className="lbl">{f.key}</span>
              <div className="track">
                {counts.filter((c) => c.n > 0).map((c) => (
                  <i
                    key={c.l}
                    style={{ background: `var(--${c.l === 'neoforge' ? 'neo' : c.l})`, width: `${(c.n / sum) * 100}%` }}
                    title={`${LOADER_LABEL[c.l]} · ${fmt(c.n)} mods (${Math.round((c.n / sum) * 100)}%)`}
                    onMouseEnter={() => setTip(`${f.key}: ${LOADER_LABEL[c.l]} ${Math.round((c.n / sum) * 100)}% (${fmt(c.n)} mods)`)}
                    onMouseLeave={() => setTip(null)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="note" style={{ marginTop: 12, minHeight: 18 }}>
        {tip ?? 'Hover a segment for exact numbers. Counts combine both platforms.'}
      </div>
    </div>
  );
}
