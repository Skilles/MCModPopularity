export const LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'] as const;
export type Loader = (typeof LOADERS)[number];

export interface Activity {
  sampled: number;
  active: number;
}
export interface PlatformStats {
  mods: number;
  modpacks: number;
  modsApprox?: boolean;
  downloads: number;
  /** Downloads split evenly across each project's supported versions; the
   *  popularity score's input. Absent on `totals` (equal to downloads there). */
  downloadsWeighted?: number;
}
export interface VersionEntry {
  v: string;
  date: string;
  cf: PlatformStats;
  mr: PlatformStats & { activity: Activity };
}
export interface FamilyEntry {
  key: string;
  date: string;
  cf: PlatformStats & { loaders: Record<Loader, number> };
  mr: PlatformStats & { loaders: Record<Loader, number>; activity: Activity };
  versions: VersionEntry[];
}
export interface Dataset {
  generatedAt: string;
  sweepSize: { mods: number; modpacks: number };
  sweptProjects: { cf: number; mr: number };
  activeDays: number;
  activitySample: number;
  /** ISO date of the exact-count enumeration in effect, or null if counts
   *  over the CurseForge cap were estimated this run. */
  cfExactFrom: string | null;
  cfCategoryFactor: { mods: number; modpacks: number };
  totals: { cf: PlatformStats; mr: PlatformStats };
  families: FamilyEntry[];
}
export interface Snapshot {
  date: string;
  families: Record<string, {
    cf: { mods: number; modpacks: number; dl: number };
    mr: { mods: number; modpacks: number; dl: number };
  }>;
}

export type Metric = 'mods' | 'modpacks' | 'downloads';

/** 21_600_000_000 -> "21.6B", 29_303 -> "29.3k" */
export function fmt(n: number): string {
  if (n >= 1e9) return trim(n / 1e9) + 'B';
  if (n >= 1e6) return trim(n / 1e6) + 'M';
  if (n >= 1e3) return trim(n / 1e3) + 'k';
  return String(n);
}
const trim = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ''));

export const total = (f: { cf: PlatformStats; mr: PlatformStats }, m: Metric) =>
  f.cf[m] + f.mr[m];

/** Families ordered oldest -> newest with enough data to chart. */
export function chartFamilies(data: Dataset, minMods = 100): FamilyEntry[] {
  return data.families
    .filter((f) => f.cf.mods + f.mr.mods >= minMods)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------- popularity

/**
 * 0-100 popularity index: downloads 34% + mod count 30% + modpack count 16%
 * + maintenance activity 20%. Downloads use square-root scaling (log
 * compressed legacy versions' accumulated-download advantage too much);
 * counts stay log-scaled. Activity is the file-accurate sampled share of
 * mods that recently shipped a file for that version.
 *
 * Blended scores are min-max rescaled within the set passed in, so the
 * weakest reads 0 and the strongest 100. Callers decide the comparison set:
 * families are scored against families, and patch versions against *every*
 * patch version site-wide (drill-down then shows one family's slice of that
 * scale), so patches from different families stay comparable.
 */
export interface ScoreParts {
  downloads: number;
  mods: number;
  modpacks: number;
  activeShare: number;
  ageYears: number;
}
export interface ScoredRow {
  name: string;
  score: number;
  parts: ScoreParts;
}

interface ScoreInput {
  name: string;
  date: string;
  downloads: number;
  mods: number;
  modpacks: number;
  activity: Activity;
}

export function popularityScores(rows: ScoreInput[], generatedAt: string): ScoredRow[] {
  const now = new Date(generatedAt).getTime();
  const rootD = rows.map((r) => Math.sqrt(r.downloads));
  const logC = rows.map((r) => Math.log10(1 + r.mods));
  const logP = rows.map((r) => Math.log10(1 + r.modpacks));
  const maxD = Math.max(...rootD, 1);
  const maxC = Math.max(...logC, 1);
  const maxP = Math.max(...logP, 1);
  const scored = rows.map((r, i) => {
    // File-accurate sampled share; dampened when the sample is tiny so a
    // 5-mod version can't score 100% activity.
    const raw = r.activity.sampled ? r.activity.active / r.activity.sampled : 0;
    const activeShare = raw * Math.min(1, r.activity.sampled / 30);
    const ageYears = Math.max(0, (now - new Date(r.date).getTime()) / (365.25 * 86_400_000));
    const recency = Math.exp(-ageYears / 2.5);
    const blend =
      0.33 * (rootD[i] / maxD) +
      0.31 * (logC[i] / maxC) +
      0.17 * (logP[i] / maxP) +
      0.19 * Math.min(activeShare, 1)
    return {
      name: r.name,
      blend,
      parts: { downloads: r.downloads, mods: r.mods, modpacks: r.modpacks, activeShare, ageYears },
    };
  });
  const min = Math.min(...scored.map((s) => s.blend));
  const max = Math.max(...scored.map((s) => s.blend));
  return scored.map((s) => ({
    name: s.name,
    score: max > min ? Math.round(((s.blend - min) / (max - min)) * 100) : 100,
    parts: s.parts,
  }));
}

export const familyScoreInput = (f: FamilyEntry): ScoreInput => ({
  name: f.key,
  date: f.date,
  downloads:
    (f.cf.downloadsWeighted ?? f.cf.downloads) + (f.mr.downloadsWeighted ?? f.mr.downloads),
  mods: total(f, 'mods'),
  modpacks: total(f, 'modpacks'),
  activity: f.mr.activity,
});
export const versionScoreInput = (v: VersionEntry): ScoreInput => ({
  name: v.v,
  date: v.date,
  downloads:
    (v.cf.downloadsWeighted ?? v.cf.downloads) + (v.mr.downloadsWeighted ?? v.mr.downloads),
  mods: v.cf.mods + v.mr.mods,
  modpacks: v.cf.modpacks + v.mr.modpacks,
  activity: v.mr.activity,
});

// ------------------------------------------------------------------- loaders

/**
 * Both APIs match version+loader filters at the project level, so a mod with
 * a NeoForge 1.20 file and a Forge 1.16 file "matches" NeoForge+1.16. Zero
 * out combos that predate the loader's first supported version family.
 */
const LOADER_MIN_DATE: Partial<Record<Loader, string>> = {
  fabric: '2019-04-01', // 1.14
  quilt: '2021-11-01', // 1.18
  neoforge: '2023-06-01', // 1.20 (forked at 1.20.1)
};

export function familyLoaderCounts(f: FamilyEntry): Record<Loader, number> {
  const out = {} as Record<Loader, number>;
  for (const l of LOADERS) {
    const min = LOADER_MIN_DATE[l];
    out[l] = min && f.date < min ? 0 : f.cf.loaders[l] + f.mr.loaders[l];
  }
  return out;
}

/**
 * Top loader across recent and popular versions (per the user: the last ~2
 * years of versions plus popular older ones like 1.12-1.20, with newer
 * versions counting more). Each family's loader counts are weighted by its
 * popularity score times a recency decay, so recent families dominate and
 * popular legacy families still contribute proportionally.
 */
export function weightedTopLoader(families: FamilyEntry[], generatedAt: string) {
  const scores = new Map(
    popularityScores(families.map(familyScoreInput), generatedAt).map((s) => [s.name, s.score]),
  );
  const now = new Date(generatedAt).getTime();
  const weighted = Object.fromEntries(LOADERS.map((l) => [l, 0])) as Record<Loader, number>;
  for (const f of families) {
    const ageYears = Math.max(0, (now - new Date(f.date).getTime()) / (365.25 * 86_400_000));
    const w = (scores.get(f.key) ?? 0) * Math.exp(-ageYears / 5);
    const counts = familyLoaderCounts(f);
    for (const l of LOADERS) weighted[l] += w * counts[l];
  }
  const sum = LOADERS.reduce((a, l) => a + weighted[l], 0);
  const loader = LOADERS.reduce((a, l) => (weighted[l] > weighted[a] ? l : a), LOADERS[0]);
  return { loader, share: sum > 0 ? weighted[loader] / sum : 0 };
}
