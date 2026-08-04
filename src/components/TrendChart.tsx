import { useMemo, useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { Snapshot } from '../lib/data';

const COLORS = [
  'var(--mr)', 'var(--forge)', 'var(--fabric)', 'var(--quilt)',
  'var(--cf)', 'var(--gold)', 'var(--grass-deep)', 'var(--stone)',
];
const DEFAULT_VISIBLE = new Set(['1.7', '1.12', '1.20', '1.21', '26.2']);

/** "1.20" -> [1, 20]; works for the date-based scheme too ("26.2" -> [26, 2]). */
const parts = (k: string) => k.split('.').map(Number);
const byAge = (a: string, b: string) => {
  const [am, an] = parts(a);
  const [bm, bn] = parts(b);
  return am - bm || an - bn;
};

/** Share of combined downloads per family across daily snapshots. */
export default function TrendChart({ snapshots }: { snapshots: Snapshot[] }) {
  const [hiddenState, setHiddenState] = useState<Set<string> | null>(null);
  const { rows, keys } = useMemo(() => {
    const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
    const latest = sorted.at(-1);
    if (!latest) return { rows: [], keys: [] as string[] };

    const keys = Object.keys(latest.families).sort(byAge);
    const rows = sorted.map((s) => {
      const all = Object.values(s.families).reduce((a, f) => a + f.cf.dl + f.mr.dl, 0);
      const row: Record<string, number | string> = { date: s.date.slice(5) };
      for (const k of keys) {
        const f = s.families[k];
        row[k] = f && all > 0 ? +(((f.cf.dl + f.mr.dl) / all) * 100).toFixed(2) : 0;
      }
      return row;
    });
    return { rows, keys };
  }, [snapshots]);

  if (rows.length < 2) {
    return (
      <div className="empty-note">
        Trends appear once a few daily snapshots have accumulated — check back soon.
      </div>
    );
  }

  const hidden = hiddenState ?? new Set(keys.filter((k) => !DEFAULT_VISIBLE.has(k)));
  const toggle = (k: string) =>
    setHiddenState(() => {
      const next = new Set(hidden);
      if (next.has(k)) next.delete(k);
      else if (next.size < keys.length - 1) next.add(k); // keep at least one visible
      return next;
    });
  const colorOf = (k: string) => COLORS[keys.indexOf(k) % COLORS.length];
  const visible = keys.filter((k) => !hidden.has(k));

  return (
    <div>
      <div className="legend" style={{ marginBottom: 6 }}>
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            className={`chip${hidden.has(k) ? ' off' : ''}`}
            onClick={() => toggle(k)}
            aria-pressed={!hidden.has(k)}
            title={hidden.has(k) ? `Show ${k}` : `Hide ${k}`}
          >
            <i style={{ background: colorOf(k) }} />
            <span>{k}</span>
          </button>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={rows} margin={{ top: 10, right: 10, left: 4, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={{ stroke: 'var(--baseline)' }}
            tick={{ fill: 'var(--muted)', fontSize: 12.5, fontFamily: 'IBM Plex Mono, monospace' }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'var(--muted)', fontSize: 12.5, fontFamily: 'IBM Plex Mono, monospace' }}
            tickFormatter={(v: number) => `${v}%`}
            width={48}
          />
          <Tooltip
            cursor={{ stroke: 'var(--baseline)' }}
            isAnimationActive={false}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              return (
                <div className="chart-tip">
                  <div className="t">{label}</div>
                  {payload.map((p) => (
                    <div className="row" key={String(p.dataKey)}>
                      <i style={{ background: colorOf(String(p.dataKey)) }} />
                      {String(p.dataKey)}<b>{p.value}%</b>
                    </div>
                  ))}
                </div>
              );
            }}
          />
          {visible.map((k) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              stroke={colorOf(k)}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
