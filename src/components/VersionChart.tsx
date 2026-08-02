import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { fmt, type FamilyEntry, type Metric } from '../lib/data';

const METRICS: { key: Metric; label: string }[] = [
  { key: 'mods', label: 'Mods' },
  { key: 'modpacks', label: 'Modpacks' },
  { key: 'downloads', label: 'Downloads' },
];

interface Row {
  name: string;
  cf: number;
  mr: number;
  total: number;
  approx: boolean;
}

export default function VersionChart({ families }: { families: FamilyEntry[] }) {
  const [metric, setMetric] = useState<Metric>('mods');
  const [drill, setDrill] = useState<string | null>(null);

  const family = drill ? families.find((f) => f.key === drill) : undefined;
  const rows: Row[] = useMemo(() => {
    const source = family
      ? family.versions.map((v) => ({ name: v.v, cf: v.cf, mr: v.mr }))
      : families.map((f) => ({ name: f.key, cf: f.cf, mr: f.mr }));
    return source.map((s) => ({
      name: s.name,
      cf: s.cf[metric],
      mr: s.mr[metric],
      total: s.cf[metric] + s.mr[metric],
      approx: metric !== 'downloads' && !!s.cf.modsApprox,
    }));
  }, [families, family, metric]);

  const showLabels = rows.length <= 14;

  return (
    <div>
      <div className="card-head">
        <div>
          <h2>{family ? `${family.key} patch versions` : `${METRICS.find((m) => m.key === metric)!.label} per Minecraft version`}</h2>
          <div className="note">
            {family
              ? <button className="back-btn" onClick={() => setDrill(null)}>← All versions</button>
              : 'Grouped by version family — click a bar to drill into patch versions'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="legend">
            <span><i style={{ background: 'var(--cf)' }} />CurseForge</span>
            <span><i style={{ background: 'var(--mr)' }} />Modrinth</span>
          </div>
          <div className="seg">
            {METRICS.map((m) => (
              <button key={m.key} className={metric === m.key ? 'on' : ''} onClick={() => setMetric(m.key)}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={rows} margin={{ top: 18, right: 4, left: 4, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="name"
            tickLine={false}
            axisLine={{ stroke: 'var(--baseline)', strokeWidth: 2 }}
            tick={{ fill: 'var(--muted)', fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }}
            interval={rows.length > 20 ? 1 : 0}
            angle={rows.length > 14 ? -38 : 0}
            height={rows.length > 14 ? 46 : 30}
            textAnchor={rows.length > 14 ? 'end' : 'middle'}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'var(--muted)', fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }}
            tickFormatter={fmt}
            width={44}
          />
          <Tooltip cursor={{ fill: 'var(--ring)' }} content={<Tip metric={metric} />} isAnimationActive={false} />
          <Bar
            dataKey="cf"
            stackId="a"
            fill="var(--cf)"
            onClick={(d: Row) => !family && setDrill(d.name)}
            cursor={family ? undefined : 'pointer'}
            isAnimationActive={false}
          />
          <Bar
            dataKey="mr"
            stackId="a"
            fill="var(--mr)"
            onClick={(d: Row) => !family && setDrill(d.name)}
            cursor={family ? undefined : 'pointer'}
            isAnimationActive={false}
          >
            {showLabels && (
              <LabelList
                dataKey="total"
                position="top"
                formatter={fmt}
                style={{ fill: 'var(--ink-2)', fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }}
              />
            )}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Tip({ active, payload, label, metric }: {
  active?: boolean;
  payload?: { payload: Row }[];
  label?: string;
  metric: Metric;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const suffix = row.approx ? ' (approx.)' : '';
  return (
    <div className="chart-tip">
      <div className="t">{label}</div>
      <div className="row"><i style={{ background: 'var(--cf)' }} />CurseForge<b>{fmt(row.cf)}{suffix}</b></div>
      <div className="row"><i style={{ background: 'var(--mr)' }} />Modrinth<b>{fmt(row.mr)}</b></div>
      <div className="row" style={{ marginTop: 2 }}>Total {metric}<b>{fmt(row.total)}</b></div>
    </div>
  );
}
