import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  familyScoreInput, fmt, popularityScores, versionScoreInput,
  type FamilyEntry, type Metric, type ScoreParts,
} from '../lib/data';

type Tab = 'popularity' | Metric;
const TABS: { key: Tab; label: string }[] = [
  { key: 'popularity', label: 'Popularity' },
  { key: 'mods', label: 'Mods' },
  { key: 'modpacks', label: 'Modpacks' },
  { key: 'downloads', label: 'Downloads' },
];

interface Row {
  name: string;
  cf: number;
  mr: number;
  total: number;
  score?: number;
  parts?: ScoreParts;
  approx: boolean;
}

export default function VersionChart({ families, generatedAt }: {
  families: FamilyEntry[];
  generatedAt: string;
}) {
  const [tab, setTab] = useState<Tab>('popularity');
  const [drill, setDrill] = useState<string | null>(null);

  const family = drill ? families.find((f) => f.key === drill) : undefined;
  const rows: Row[] = useMemo(() => {
    if (tab === 'popularity') {
      const scored = family
        ? popularityScores(family.versions.map(versionScoreInput), generatedAt)
        : popularityScores(families.map(familyScoreInput), generatedAt);
      return scored.map((s) => ({
        name: s.name, cf: 0, mr: 0, total: s.score, score: s.score, parts: s.parts, approx: false,
      }));
    }
    const source = family
      ? family.versions.map((v) => ({ name: v.v, cf: v.cf, mr: v.mr }))
      : families.map((f) => ({ name: f.key, cf: f.cf, mr: f.mr }));
    return source.map((s) => ({
      name: s.name,
      cf: s.cf[tab],
      mr: s.mr[tab],
      total: s.cf[tab] + s.mr[tab],
      approx: tab !== 'downloads' && !!s.cf.modsApprox,
    }));
  }, [families, family, tab, generatedAt]);

  const showLabels = rows.length <= 14;
  const isScore = tab === 'popularity';
  const title = isScore
    ? 'Popularity index'
    : TABS.find((t) => t.key === tab)!.label + ' per Minecraft version';

  return (
    <div>
      <div className="card-head">
        <div>
          <h2>{family ? `${family.key} — ${title.toLowerCase()}` : title}</h2>
          <div className="note">
            {family
              ? <button className="back-btn" onClick={() => setDrill(null)}>← All versions</button>
              : isScore
                ? 'Blends downloads, mod count, maintenance activity, and version age — click a bar for patch versions'
                : 'Grouped by version family — click a bar to drill into patch versions'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {!isScore && (
            <div className="legend">
              <span><i style={{ background: 'var(--cf)' }} />CurseForge</span>
              <span><i style={{ background: 'var(--mr)' }} />Modrinth</span>
            </div>
          )}
          <div className="seg">
            {TABS.map((t) => (
              <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={360}>
        <BarChart data={rows} margin={{ top: 22, right: 4, left: 4, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="name"
            tickLine={false}
            axisLine={{ stroke: 'var(--baseline)', strokeWidth: 2 }}
            tick={{ fill: 'var(--muted)', fontSize: 12.5, fontFamily: 'IBM Plex Mono, monospace' }}
            interval={rows.length > 20 ? 1 : 0}
            angle={rows.length > 14 ? -38 : 0}
            height={rows.length > 14 ? 52 : 34}
            textAnchor={rows.length > 14 ? 'end' : 'middle'}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            domain={isScore ? [0, 100] : undefined}
            tick={{ fill: 'var(--muted)', fontSize: 12.5, fontFamily: 'IBM Plex Mono, monospace' }}
            tickFormatter={fmt}
            width={48}
          />
          <Tooltip cursor={{ fill: 'var(--ring)' }} content={<Tip isScore={isScore} metric={tab} />} isAnimationActive={false} />
          {isScore ? (
            <Bar
              dataKey="score"
              fill="var(--grass)"
              onClick={(d: Row) => !family && setDrill(d.name)}
              cursor={family ? undefined : 'pointer'}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="score"
                position="top"
                style={{ fill: 'var(--ink-2)', fontSize: 12, fontFamily: 'IBM Plex Mono, monospace' }}
              />
            </Bar>
          ) : (
            <>
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
                    style={{ fill: 'var(--ink-2)', fontSize: 12, fontFamily: 'IBM Plex Mono, monospace' }}
                  />
                )}
              </Bar>
            </>
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Tip({ active, payload, label, isScore, metric }: {
  active?: boolean;
  payload?: { payload: Row }[];
  label?: string;
  isScore: boolean;
  metric: Tab;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  if (isScore && row.parts) {
    return (
      <div className="chart-tip">
        <div className="t">{label} — score {row.score}</div>
        <div className="row">Downloads<b>{fmt(row.parts.downloads)}</b></div>
        <div className="row">Mods<b>{fmt(row.parts.mods)}</b></div>
        <div className="row">Recently updated<b>{Math.round(row.parts.activeShare * 100)}%</b></div>
        <div className="row">Age<b>{row.parts.ageYears < 0.1 ? 'new' : `${row.parts.ageYears.toFixed(1)}y`}</b></div>
      </div>
    );
  }
  const suffix = row.approx ? ' (est.)' : '';
  return (
    <div className="chart-tip">
      <div className="t">{label}</div>
      <div className="row"><i style={{ background: 'var(--cf)' }} />CurseForge<b>{fmt(row.cf)}{suffix}</b></div>
      <div className="row"><i style={{ background: 'var(--mr)' }} />Modrinth<b>{fmt(row.mr)}</b></div>
      <div className="row" style={{ marginTop: 2 }}>Total {metric}<b>{fmt(row.total)}</b></div>
    </div>
  );
}
