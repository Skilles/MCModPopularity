export const LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'] as const;
export type Loader = (typeof LOADERS)[number];

export interface PlatformStats {
  mods: number;
  modpacks: number;
  modsApprox?: boolean;
  downloads: number;
}
export interface VersionEntry {
  v: string;
  date: string;
  cf: PlatformStats;
  mr: PlatformStats;
}
export interface FamilyEntry {
  key: string;
  date: string;
  cf: PlatformStats & { loaders: Record<Loader, number> };
  mr: PlatformStats & { loaders: Record<Loader, number> };
  versions: VersionEntry[];
}
export interface Dataset {
  generatedAt: string;
  sweepSize: { mods: number; modpacks: number };
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
