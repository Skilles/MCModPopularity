import { useState } from 'react';
import { fmt, total, type FamilyEntry, type Metric, type PlatformStats } from '../lib/data';
import { useHoverTip } from './useHoverTip';

const METRICS: { key: Metric; label: string }[] = [
  { key: 'downloads', label: 'Downloads' },
  { key: 'mods', label: 'Mods' },
  { key: 'modpacks', label: 'Modpacks' },
];

/** CurseForge vs Modrinth split per version family, newest first. */
export default function PlatformShare({ families, totals }: {
  families: FamilyEntry[];
  totals: { cf: PlatformStats; mr: PlatformStats };
}) {
  const [metric, setMetric] = useState<Metric>('downloads');
  const { bind, tipEl } = useHoverTip();

  const overallCf = totals.cf[metric];
  const overallMr = totals.mr[metric];
  const overallPct = Math.round((overallMr / (overallCf + overallMr)) * 100);

  const rows = [...families]
    .reverse()
    .map((f) => ({ key: f.key, cf: f.cf[metric], mr: f.mr[metric], sum: total(f, metric) }))
    .filter((r) => r.sum > 0);

  return (
    <div>
      <div className="card-head" style={{ marginBottom: 14 }}>
        <div className="legend">
          <span><i style={{ background: 'var(--cf)' }} />CurseForge {100 - overallPct}%</span>
          <span><i style={{ background: 'var(--mr)' }} />Modrinth {overallPct}%</span>
          <span style={{ color: 'var(--muted)' }}>overall, all {metric}</span>
        </div>
        <div className="seg">
          {METRICS.map((m) => (
            <button key={m.key} className={metric === m.key ? 'on' : ''} onClick={() => setMetric(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="tip-host">
        {tipEl}
        <div className="hbars scroll">
          {rows.map((r) => {
            const mrPct = Math.round((r.mr / r.sum) * 100);
            const tipContent = (
              <>
                <div className="t">{r.key}</div>
                <div className="row"><i style={{ background: 'var(--cf)' }} />CurseForge<b>{fmt(r.cf)} ({100 - mrPct}%)</b></div>
                <div className="row"><i style={{ background: 'var(--mr)' }} />Modrinth<b>{fmt(r.mr)} ({mrPct}%)</b></div>
              </>
            );
            return (
              <div className="hrow" key={r.key}>
                <span className="lbl">{r.key}</span>
                <div className="track">
                  {r.cf > 0 && (
                    <i style={{ background: 'var(--cf)', width: `${(r.cf / r.sum) * 100}%` }} {...bind(tipContent)} />
                  )}
                  {r.mr > 0 && (
                    <i style={{ background: 'var(--mr)', width: `${(r.mr / r.sum) * 100}%` }} {...bind(tipContent)} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
