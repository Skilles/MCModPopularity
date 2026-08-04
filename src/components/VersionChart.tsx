import { useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis,
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

/** Tracks the data-blocks attribute the header logo toggles. Starts false to
 *  match the server-rendered HTML (hydration never patches attribute
 *  mismatches); the effect flips it on right after mount. */
function useBlockTextures() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    setOn(el.dataset.blocks === 'on');
    const obs = new MutationObserver(() => setOn(el.dataset.blocks === 'on'));
    obs.observe(el, { attributes: true, attributeFilter: ['data-blocks'] });
    return () => obs.disconnect();
  }, []);
  return on;
}

export default function VersionChart({ families, generatedAt }: {
  families: FamilyEntry[];
  generatedAt: string;
}) {
  const [tab, setTab] = useState<Tab>('mods');
  const [drill, setDrill] = useState<string | null>(null);
  const [trueScale, setTrueScale] = useState(true);
  const blocks = useBlockTextures();

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
  // Auto ticks cluster near the top on a sqrt scale; use ticks that sit
  // evenly spaced on it instead (quadratic fractions of a rounded-up max).
  const maxTotal = Math.max(...rows.map((r) => r.total), 1);
  const tickTop = niceCeil(maxTotal);
  const sqrtTicks = !isScore && !trueScale
    ? [...new Set([0, ...[1 / 16, 4 / 16, 9 / 16].map((f) => niceTick(f * tickTop)), tickTop])]
    : undefined;
  const title = isScore
    ? 'Popularity index'
    : TABS.find((t) => t.key === tab)!.label + ' per Minecraft version';

  return (
    <div>
      <div className="card-head">
        <div>
          <h2 style={{ display: 'flex', alignItems: 'center' }}>
            {family ? `${family.key} — ${title.toLowerCase()}` : title}
            {isScore && (
              <span className="info-tip" tabIndex={0} role="note" aria-label="How the popularity index works">
                <span aria-hidden="true">i</span>
                <span className="tip-body">
                  Combines downloads, mod and modpack counts, recent updates, and age
                  into a 0–100 score.
                </span>
              </span>
            )}
          </h2>
          <div className="note">
            {family
              ? <button className="back-btn" onClick={() => setDrill(null)}>← All versions</button>
              : isScore
                ? 'How popular each version is with modders today — click a bar to see its patch versions'
                : 'Grouped by version family — click a bar to see its patch versions'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {!isScore && (
            <div className="legend">
              <span><i style={{ background: blocks ? 'var(--dirt)' : 'var(--cf)' }} />CurseForge</span>
              <span><i style={{ background: blocks ? 'var(--grass)' : 'var(--mr)' }} />Modrinth</span>
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
            tickFormatter={(v: string) => (family ? v : `${v}.x`)}
            interval={rows.length > 20 ? 1 : 0}
            angle={rows.length > 14 ? -38 : 0}
            height={rows.length > 14 ? 52 : 34}
            textAnchor={rows.length > 14 ? 'end' : 'middle'}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            scale={isScore || trueScale ? 'linear' : 'sqrt'}
            domain={isScore ? [0, 100] : sqrtTicks ? [0, sqrtTicks[sqrtTicks.length - 1]] : [0, 'auto']}
            ticks={sqrtTicks}
            tick={{ fill: 'var(--muted)', fontSize: 12.5, fontFamily: 'IBM Plex Mono, monospace' }}
            tickFormatter={fmt}
            width={48}
          />
          <Tooltip cursor={{ fill: 'var(--ring)' }} content={<Tip isScore={isScore} metric={tab} blocks={blocks} labelSuffix={family ? '' : '.x'} />} isAnimationActive={false} />
          {isScore ? (
            <Bar
              dataKey="score"
              shape={blocks ? <GrassBar /> : undefined}
              radius={blocks ? undefined : [4, 4, 0, 0]}
              onClick={(d: Row) => !family && setDrill(d.name)}
              cursor={family ? undefined : 'pointer'}
              isAnimationActive={false}
            >
              {!blocks && rows.map((r, i) => (
                <Cell key={r.name} fill={i % 2 ? 'var(--grass-alt)' : 'var(--grass)'} />
              ))}
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
                shape={blocks ? <DirtBar /> : undefined}
                onClick={(d: Row) => !family && setDrill(d.name)}
                cursor={family ? undefined : 'pointer'}
                isAnimationActive={false}
              />
              <Bar
                dataKey="mr"
                stackId="a"
                fill="var(--mr)"
                shape={blocks ? <GrassSegBar sqrtScale={!trueScale} /> : undefined}
                radius={blocks ? undefined : [4, 4, 0, 0]}
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
      {!isScore && (
        <div className="scale-toggle">
          Scale:
          <button
            className={trueScale ? 'on' : ''}
            onClick={() => setTrueScale(true)}
            title="True proportions — big versions tower over small ones"
          >
            actual
          </button>
          ·
          <button
            className={!trueScale ? 'on' : ''}
            onClick={() => setTrueScale(false)}
            title="Compressed scale keeps smaller versions visible"
          >
            compressed
          </button>
        </div>
      )}
    </div>
  );
}

const TICK_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** Round to the closest "nice" number (1/1.5/2/2.5/3/4/5/6/8 × 10^n). */
function niceTick(v: number): number {
  if (v <= 0) return 0;
  const mag = 10 ** Math.floor(Math.log10(v));
  const r = v / mag;
  let best = TICK_STEPS[0];
  for (const s of TICK_STEPS) if (Math.abs(s - r) < Math.abs(best - r)) best = s;
  return best * mag;
}

/** Round up to the next "nice" number, so the axis never clips a bar. */
function niceCeil(v: number): number {
  if (v <= 0) return 0;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const s of TICK_STEPS) if (s * mag >= v) return s * mag;
  return 10 * mag;
}

/** Deterministic pseudo-random in [0, 1) — stable across re-renders so the
 *  textures look random without flickering. */
function rnd(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Minecraft block bar: even bars are grass-capped dirt, odd bars are
 * moss-capped cobblestone. Every texture (body and cap) is a seeded-random
 * pixel speckle unique to that bar.
 */
function GrassBar({ x, y, width, height, index }: {
  x?: number; y?: number; width?: number; height?: number; index?: number;
}) {
  if (x == null || y == null || !width || !height || height <= 0) return null;
  const i = index ?? 0;
  const cobble = i % 2 === 1;
  const body = cobble ? 'var(--stone)' : 'var(--dirt)';
  const capColor = cobble ? 'var(--moss)' : 'var(--grass)';
  const cap = Math.min(7, height);

  // body speckles: darker/lighter pixels scattered on a 6px grid
  const speckles: { px: number; py: number; s: number; f: string }[] = [];
  const darkChance = cobble ? 0.14 : 0.1;
  const lightChance = cobble ? 0.26 : 0.17;
  for (let cy = cap; cy + 3 < height; cy += 6) {
    for (let cx = 0; cx + 3 < width; cx += 6) {
      const r = rnd(i, cx, cy);
      if (r < darkChance || (r >= 0.5 && r < 0.5 + lightChance - darkChance)) {
        const s = 2 + Math.floor(rnd(i, cx + 2, cy) * (cobble ? 4 : 3));
        speckles.push({
          px: Math.min(x + cx + Math.floor(rnd(i, cx + 1, cy) * 3), x + width - s),
          py: Math.min(y + cy + Math.floor(rnd(i, cx, cy + 1) * 3), y + height - s),
          s,
          f: r < darkChance ? 'rgba(0, 0, 0, 0.18)' : `rgba(255, 255, 255, ${cobble ? 0.09 : 0.07})`,
        });
      }
    }
  }

  // cap speckles: finer 3px-grid noise on the grass/moss
  const capSpeckles: { px: number; s: number; f: string }[] = [];
  for (let cx = 0; cx + 2 < width; cx += 3) {
    const r = rnd(i, cx, 9001);
    if (r < 0.3) {
      capSpeckles.push({
        px: x + cx,
        s: 2,
        f: r < 0.15 ? 'rgba(0, 0, 0, 0.16)' : 'rgba(255, 255, 255, 0.12)',
      });
    }
  }

  // grass/moss "teeth" hanging below the cap, with jittered positions
  const showTeeth = height > cap + 6 && width >= 16;
  const teeth = showTeeth
    ? [0.1, 0.45, 0.78].map((base, k) => {
        const tx = x + width * (base + rnd(i, k, 7331) * 0.1);
        return {
          tx,
          tw: Math.min(Math.max(2, width * (0.08 + rnd(i, k, 4242) * 0.08)), x + width - tx),
          th: 3 + Math.floor(rnd(i, k, 1717) * 3),
        };
      })
    : [];

  return (
    <g shapeRendering="crispEdges">
      <rect x={x} y={y + cap} width={width} height={height - cap} fill={body} />
      {speckles.map((p, k) => (
        <rect key={k} x={p.px} y={p.py} width={p.s} height={p.s} fill={p.f} />
      ))}
      <rect x={x} y={y} width={width} height={cap} fill={capColor} />
      {capSpeckles.map((p, k) => (
        <rect key={k} x={p.px} y={y + 1 + Math.floor(rnd(i, p.px, 55) * (cap - 3))} width={p.s} height={p.s} fill={p.f} />
      ))}
      {teeth.map((t, k) => (
        <rect key={k} x={t.tx} y={y + cap} width={t.tw} height={t.th} fill={capColor} />
      ))}
    </g>
  );
}

/** CurseForge segment in blocks mode: a plain dirt column with speckles. */
function DirtBar({ x, y, width, height, index }: {
  x?: number; y?: number; width?: number; height?: number; index?: number;
}) {
  if (x == null || y == null || !width || !height || height <= 0) return null;
  const i = (index ?? 0) + 101;
  const speckles: { px: number; py: number; s: number; f: string }[] = [];
  for (let cy = 0; cy + 3 < height; cy += 6) {
    for (let cx = 0; cx + 3 < width; cx += 6) {
      const r = rnd(i, cx, cy);
      if (r < 0.1 || (r >= 0.5 && r < 0.57)) {
        const s = 2 + Math.floor(rnd(i, cx + 2, cy) * 3);
        speckles.push({
          px: Math.min(x + cx + Math.floor(rnd(i, cx + 1, cy) * 3), x + width - s),
          py: Math.min(y + cy + Math.floor(rnd(i, cx, cy + 1) * 3), y + height - s),
          s,
          f: r < 0.1 ? 'rgba(0, 0, 0, 0.16)' : 'rgba(255, 255, 255, 0.07)',
        });
      }
    }
  }
  return (
    <g shapeRendering="crispEdges">
      <rect x={x} y={y} width={width} height={height} fill="var(--dirt)" />
      {speckles.map((p, k) => (
        <rect key={k} x={p.px} y={p.py} width={p.s} height={p.s} fill={p.f} />
      ))}
    </g>
  );
}

/** Modrinth segment in blocks mode: a grass layer sitting on the dirt, with
 *  speckles and jittered teeth hanging into the segment below. */
function GrassSegBar({ x, y, width, height, index, payload, sqrtScale }: {
  x?: number; y?: number; width?: number; height?: number; index?: number;
  payload?: Row;
  sqrtScale?: boolean;
}) {
  if (x == null || y == null || !width || !height || height <= 0) return null;
  const i = (index ?? 0) + 707;
  // teeth may only hang into the dirt segment below — never past the
  // baseline. On the sqrt scale, segment boundaries sit at sqrt positions,
  // so the dirt height relates to this segment's height accordingly.
  const sTotal = payload ? (sqrtScale ? Math.sqrt(payload.cf + payload.mr) : payload.cf + payload.mr) : 0;
  const sCf = payload ? (sqrtScale ? Math.sqrt(payload.cf) : payload.cf) : 0;
  const dirtPx = sTotal > sCf ? (height * sCf) / (sTotal - sCf) : 0;
  const speckles: { px: number; py: number; s: number; f: string }[] = [];
  for (let cy = 0; cy + 2 < height; cy += 5) {
    for (let cx = 0; cx + 2 < width; cx += 5) {
      const r = rnd(i, cx, cy);
      if (r < 0.09 || (r >= 0.5 && r < 0.62)) {
        speckles.push({
          px: Math.min(x + cx + Math.floor(rnd(i, cx + 1, cy) * 3), x + width - 2),
          py: Math.min(y + cy + Math.floor(rnd(i, cx, cy + 1) * 3), y + height - 2),
          s: 2,
          f: r < 0.09 ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.11)',
        });
      }
    }
  }
  const teeth = width >= 16 && dirtPx >= 3
    ? [0.1, 0.45, 0.78].map((base, k) => {
        const tx = x + width * (base + rnd(i, k, 7331) * 0.1);
        return {
          tx,
          tw: Math.min(Math.max(2, width * (0.08 + rnd(i, k, 4242) * 0.08)), x + width - tx),
          th: Math.min(3 + Math.floor(rnd(i, k, 1717) * 3), Math.floor(dirtPx)),
        };
      })
    : [];
  return (
    <g shapeRendering="crispEdges">
      <rect x={x} y={y} width={width} height={height} fill="var(--grass)" />
      {speckles.map((p, k) => (
        <rect key={k} x={p.px} y={p.py} width={p.s} height={p.s} fill={p.f} />
      ))}
      {teeth.map((t, k) => (
        <rect key={k} x={t.tx} y={y + height} width={t.tw} height={t.th} fill="var(--grass)" />
      ))}
    </g>
  );
}

function Tip({ active, payload, label, isScore, metric, blocks, labelSuffix = '' }: {
  active?: boolean;
  payload?: { payload: Row }[];
  label?: string;
  isScore: boolean;
  metric: Tab;
  blocks?: boolean;
  labelSuffix?: string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  if (isScore && row.parts) {
    return (
      <div className="chart-tip">
        <div className="t">{label}{labelSuffix} — score {row.score}</div>
        <div className="row">Downloads<b>{fmt(row.parts.downloads)}</b></div>
        <div className="row">Mods<b>{fmt(row.parts.mods)}</b></div>
        <div className="row">Modpacks<b>{fmt(row.parts.modpacks)}</b></div>
        <div className="row">Recently updated<b>{Math.round(row.parts.activeShare * 100)}%</b></div>
        <div className="row">Age<b>{row.parts.ageYears < 0.1 ? 'new' : `${row.parts.ageYears.toFixed(1)}y`}</b></div>
      </div>
    );
  }
  const suffix = row.approx ? ' (est.)' : '';
  return (
    <div className="chart-tip">
      <div className="t">{label}{labelSuffix}</div>
      <div className="row"><i style={{ background: blocks ? 'var(--dirt)' : 'var(--cf)' }} />CurseForge<b>{fmt(row.cf)}{suffix}</b></div>
      <div className="row"><i style={{ background: blocks ? 'var(--grass)' : 'var(--mr)' }} />Modrinth<b>{fmt(row.mr)}</b></div>
      <div className="row" style={{ marginTop: 2 }}>Total {metric}<b>{fmt(row.total)}</b></div>
    </div>
  );
}
