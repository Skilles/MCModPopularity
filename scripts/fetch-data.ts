/**
 * Fetches mod/modpack popularity data from CurseForge and Modrinth,
 * aggregates it per Minecraft version family, and writes:
 *   - data/latest.json          (full dataset the site builds from)
 *   - data/snapshots/DATE.json  (slim daily snapshot for trend charts)
 *
 * Files are only written when any headline metric moved >= 1% since the
 * last committed dataset (pass --force to write regardless).
 *
 * Requires CURSEFORGE_API_KEY (read from env, falling back to .env).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const SNAPSHOT_DIR = resolve(DATA_DIR, "snapshots");
const LATEST_PATH = resolve(DATA_DIR, "latest.json");

const FORCE = process.argv.includes("--force");
const THRESHOLD = 0.01;

const MODRINTH = "https://api.modrinth.com/v2";
const CURSEFORGE = "https://api.curseforge.com/v1";
const MC_GAME_ID = 432;
const CLASS_MODS = 6;
const CLASS_MODPACKS = 4471;
/** CurseForge search results are hard-capped at this count. */
const CF_CAP = 10_000;
/** Global sweep depth (top projects by downloads). */
const SWEEP_MODS = 10_000;
const SWEEP_MODPACKS = 5_000;
/** Additional per-family filtered sweep depth, to reach projects that the
 *  global top-N misses. Projects are deduped by id before attribution. */
const FAMILY_SWEEP_MODS = 2_000;
const FAMILY_SWEEP_MODPACKS = 500;
/** Window for the "actively maintained" metric (Modrinth only). */
const ACTIVE_DAYS = 90;

const CF_LOADERS = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 } as const;
type Loader = keyof typeof CF_LOADERS;
const LOADERS = Object.keys(CF_LOADERS) as Loader[];

// ---------------------------------------------------------------- env / http

function loadDotEnv() {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const CF_KEY = process.env.CURSEFORGE_API_KEY;
if (!CF_KEY) {
  console.error("CURSEFORGE_API_KEY is not set (env or .env)");
  process.exit(1);
}

/** Serial request queue per host with a fixed delay, retries on 429/5xx. */
function makeClient(headers: Record<string, string>, delayMs: number) {
  let chain = Promise.resolve();
  return function request<T>(url: string): Promise<T> {
    const result = chain.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) }).catch((e) => {
          if (attempt >= 4) throw e;
          return null;
        });
        if (res?.ok) return (await res.json()) as T;
        if (res && res.status < 500 && res.status !== 429) {
          throw new Error(`${res.status} ${res.statusText}: ${url}`);
        }
        if (attempt >= 4) throw new Error(`giving up after ${attempt + 1} tries: ${url}`);
        await sleep(1500 * (attempt + 1));
      }
    });
    chain = result.then(() => sleep(delayMs), () => sleep(delayMs));
    return result;
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mr = makeClient(
  { "User-Agent": "Skilles/MCModPopularity/1.0 (github.com/Skilles/MCModPopularity)" },
  220,
);
const cf = makeClient({ "x-api-key": CF_KEY, "Accept": "application/json" }, 120);

// ------------------------------------------------------------------- shapes

interface PlatformStats {
  mods: number;
  modpacks: number;
  /** True when a CurseForge count hit the 10k result cap and was
   *  reconstructed from per-loader partitions (lower bound). */
  modsApprox?: boolean;
  /** Downloads summed over the deduped sweeps, mods + modpacks. */
  downloads: number;
}
interface FamilyEntry {
  key: string;
  /** Release date of the newest version in the family (for sorting). */
  date: string;
  cf: PlatformStats & { loaders: Record<Loader, number> };
  mr: PlatformStats & { loaders: Record<Loader, number>; active90: number };
  versions: { v: string; date: string; cf: PlatformStats; mr: PlatformStats & { active90: number } }[];
}

/** "1.20.1" -> "1.20", "26.1.2" -> "26.1", "1.21" -> "1.21" */
const familyOf = (v: string) => v.split(".").slice(0, 2).join(".");

/** Swept projects deduped by id across the global and per-family sweeps. */
interface SweptProject { downloads: number; versions: Set<string> }

function attribute(projects: Map<string | number, SweptProject>, releaseSet: Set<string>) {
  const perVersion = new Map<string, number>();
  const perFamily = new Map<string, number>();
  let total = 0;
  for (const p of projects.values()) {
    total += p.downloads;
    const families = new Set<string>();
    for (const v of p.versions) {
      if (!releaseSet.has(v)) continue;
      perVersion.set(v, (perVersion.get(v) ?? 0) + p.downloads);
      families.add(familyOf(v));
    }
    for (const f of families) perFamily.set(f, (perFamily.get(f) ?? 0) + p.downloads);
  }
  return { perVersion, perFamily, total, projects: projects.size };
}

// ------------------------------------------------------------------ modrinth

interface MrTag { version: string; version_type: string; date: string }
interface MrSearch { total_hits: number; hits: MrHit[] }
interface MrHit { project_id: string; downloads: number; versions: string[] }

const mrCount = async (facets: string[][]) => {
  const q = encodeURIComponent(JSON.stringify(facets));
  return (await mr<MrSearch>(`${MODRINTH}/search?limit=0&facets=${q}`)).total_hits;
};
const typeFacet = (t: "mod" | "modpack") => [`project_type:${t}`];
const versionsFacet = (vs: string[]) => vs.map((v) => `versions:${v}`);

async function mrSweepInto(
  out: Map<string | number, SweptProject>,
  facets: string[][],
  top: number,
) {
  const q = encodeURIComponent(JSON.stringify(facets));
  for (let offset = 0; offset < top; offset += 100) {
    const page = await mr<MrSearch>(
      `${MODRINTH}/search?limit=100&offset=${offset}&index=downloads&facets=${q}`,
    ).catch(() => null);
    if (!page || page.hits.length === 0) break;
    for (const hit of page.hits) {
      out.set(hit.project_id, { downloads: hit.downloads, versions: new Set(hit.versions) });
    }
  }
}

// ---------------------------------------------------------------- curseforge

interface CfSearch { data: CfMod[]; pagination: { totalCount: number } }
interface CfMod { id: number; downloadCount: number; latestFilesIndexes: { gameVersion: string }[] }
interface CfVersionType { id: number; name: string }

const cfSearch = (params: Record<string, string | number>) => {
  const q = new URLSearchParams({ gameId: String(MC_GAME_ID) });
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  return cf<CfSearch>(`${CURSEFORGE}/mods/search?${q}`);
};
const cfCount = async (params: Record<string, string | number>) =>
  (await cfSearch({ ...params, pageSize: 1 })).pagination.totalCount;

/**
 * Exact when under the 10k cap; otherwise the sum of per-loader counts
 * (each itself capped), which undercounts unpartitionable overflow but
 * beats reporting a flat 10,000.
 */
async function cfCountUncapped(params: Record<string, string | number>) {
  const total = await cfCount(params);
  if (total < CF_CAP) return { count: total, approx: false };
  let sum = 0;
  for (const id of Object.values(CF_LOADERS)) {
    sum += await cfCount({ ...params, modLoaderType: id });
  }
  return { count: Math.max(sum, CF_CAP), approx: true };
}

async function cfSweepInto(
  out: Map<string | number, SweptProject>,
  params: Record<string, string | number>,
  top: number,
) {
  const pageSize = 50;
  for (let index = 0; index + pageSize <= Math.min(top, CF_CAP); index += pageSize) {
    const page = await cfSearch({ ...params, sortField: 6, sortOrder: "desc", pageSize, index })
      .catch(() => null);
    if (!page || page.data.length === 0) break;
    for (const mod of page.data) {
      out.set(mod.id, {
        downloads: mod.downloadCount,
        versions: new Set(mod.latestFilesIndexes.map((f) => f.gameVersion)),
      });
    }
  }
}

// ---------------------------------------------------------------------- main

async function main() {
  console.log("Fetching Minecraft release versions from Modrinth...");
  const tags = await mr<MrTag[]>(`${MODRINTH}/tag/game_version`);
  const releases = tags.filter((t) => t.version_type === "release");
  const releaseSet = new Set(releases.map((t) => t.version));
  const families = new Map<string, MrTag[]>();
  for (const t of releases) {
    const f = familyOf(t.version);
    if (!families.has(f)) families.set(f, []);
    families.get(f)!.push(t);
  }
  console.log(`${releases.length} release versions in ${families.size} families`);

  console.log("Fetching CurseForge version types...");
  const versionTypes = (await cf<{ data: CfVersionType[] }>(
    `${CURSEFORGE}/games/${MC_GAME_ID}/version-types`,
  )).data;
  const cfTypeId = new Map<string, number>();
  for (const vt of versionTypes) {
    const m = vt.name.match(/^Minecraft ([\d.]+)$/);
    if (m) cfTypeId.set(m[1], vt.id);
  }

  const activeSince = Math.floor(Date.now() / 1000) - ACTIVE_DAYS * 86_400;
  const activeFacet = [`modified_timestamp>=${activeSince}`];

  console.log("Running download sweeps (global + per-family, deduped by project)...");
  const mrProjects = new Map<string | number, SweptProject>();
  const cfProjects = new Map<string | number, SweptProject>();
  const mrSweeps = (async () => {
    await mrSweepInto(mrProjects, [typeFacet("mod")], SWEEP_MODS);
    await mrSweepInto(mrProjects, [typeFacet("modpack")], SWEEP_MODPACKS);
    for (const [, members] of families) {
      const vf = versionsFacet(members.map((m) => m.version));
      await mrSweepInto(mrProjects, [typeFacet("mod"), vf], FAMILY_SWEEP_MODS);
      await mrSweepInto(mrProjects, [typeFacet("modpack"), vf], FAMILY_SWEEP_MODPACKS);
    }
  })();
  const cfSweeps = (async () => {
    await cfSweepInto(cfProjects, { classId: CLASS_MODS }, SWEEP_MODS);
    await cfSweepInto(cfProjects, { classId: CLASS_MODPACKS }, SWEEP_MODPACKS);
    for (const [key] of families) {
      const typeId = cfTypeId.get(key);
      if (!typeId) continue;
      await cfSweepInto(cfProjects, { classId: CLASS_MODS, gameVersionTypeId: typeId }, FAMILY_SWEEP_MODS);
      await cfSweepInto(cfProjects, { classId: CLASS_MODPACKS, gameVersionTypeId: typeId }, FAMILY_SWEEP_MODPACKS);
    }
  })();
  await Promise.all([mrSweeps, cfSweeps]);
  const mrDl = attribute(mrProjects, releaseSet);
  const cfDl = attribute(cfProjects, releaseSet);
  console.log(`  swept ${cfDl.projects} CurseForge / ${mrDl.projects} Modrinth projects`);

  console.log("Fetching global project counts...");
  const [mrTotalMods, mrTotalPacks, cfTotalMods, cfTotalPacks] = await Promise.all([
    mrCount([typeFacet("mod")]),
    mrCount([typeFacet("modpack")]),
    cfCountUncapped({ classId: CLASS_MODS }),
    cfCountUncapped({ classId: CLASS_MODPACKS }),
  ]);

  console.log("Fetching per-family and per-version counts...");
  const entries: FamilyEntry[] = [];
  for (const [key, members] of families) {
    const vs = members.map((m) => m.version);
    const typeId = cfTypeId.get(key);
    const cfFamilyParams = typeId
      ? { gameVersionTypeId: typeId }
      : { gameVersion: key }; // fallback: exact-tag match undercounts the family

    const [mrModCount, mrPackCount, mrActive, mrLoaders, cfModCount, cfPackCount, cfLoaders] =
      await Promise.all([
        mrCount([typeFacet("mod"), versionsFacet(vs)]),
        mrCount([typeFacet("modpack"), versionsFacet(vs)]),
        mrCount([typeFacet("mod"), versionsFacet(vs), activeFacet]),
        Promise.all(LOADERS.map((l) =>
          mrCount([typeFacet("mod"), versionsFacet(vs), [`categories:${l}`]]))),
        cfCountUncapped({ classId: CLASS_MODS, ...cfFamilyParams }),
        cfCountUncapped({ classId: CLASS_MODPACKS, ...cfFamilyParams }),
        Promise.all(LOADERS.map((l) =>
          cfCount({ classId: CLASS_MODS, ...cfFamilyParams, modLoaderType: CF_LOADERS[l] }))),
      ]);

    const versions = await Promise.all(members.map(async (m) => {
      const [mrM, mrP, mrA, cfM, cfP] = await Promise.all([
        mrCount([typeFacet("mod"), versionsFacet([m.version])]),
        mrCount([typeFacet("modpack"), versionsFacet([m.version])]),
        mrCount([typeFacet("mod"), versionsFacet([m.version]), activeFacet]),
        cfCountUncapped({ classId: CLASS_MODS, gameVersion: m.version }),
        cfCountUncapped({ classId: CLASS_MODPACKS, gameVersion: m.version }),
      ]);
      return {
        v: m.version,
        date: m.date.slice(0, 10),
        mr: {
          mods: mrM,
          modpacks: mrP,
          active90: mrA,
          downloads: mrDl.perVersion.get(m.version) ?? 0,
        },
        cf: {
          mods: cfM.count,
          ...(cfM.approx || cfP.approx ? { modsApprox: true } : {}),
          modpacks: cfP.count,
          downloads: cfDl.perVersion.get(m.version) ?? 0,
        },
      };
    }));

    entries.push({
      key,
      date: members.map((m) => m.date).sort().at(-1)!.slice(0, 10),
      mr: {
        mods: mrModCount,
        modpacks: mrPackCount,
        active90: mrActive,
        downloads: mrDl.perFamily.get(key) ?? 0,
        loaders: Object.fromEntries(LOADERS.map((l, i) => [l, mrLoaders[i]])) as Record<Loader, number>,
      },
      cf: {
        mods: cfModCount.count,
        ...(cfModCount.approx ? { modsApprox: true } : {}),
        modpacks: cfPackCount.count,
        downloads: cfDl.perFamily.get(key) ?? 0,
        loaders: Object.fromEntries(LOADERS.map((l, i) => [l, cfLoaders[i]])) as Record<Loader, number>,
      },
      versions: versions.sort((a, b) => a.date.localeCompare(b.date)),
    });
    console.log(`  ${key}: cf ${cfModCount.count}${cfModCount.approx ? "~" : ""} mods, mr ${mrModCount} mods, ${mrActive} active`);
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));

  const dataset = {
    generatedAt: new Date().toISOString(),
    sweepSize: { mods: SWEEP_MODS, modpacks: SWEEP_MODPACKS },
    sweptProjects: { cf: cfDl.projects, mr: mrDl.projects },
    activeDays: ACTIVE_DAYS,
    totals: {
      cf: {
        mods: cfTotalMods.count,
        ...(cfTotalMods.approx ? { modsApprox: true } : {}),
        modpacks: cfTotalPacks.count,
        downloads: cfDl.total,
      },
      mr: {
        mods: mrTotalMods,
        modpacks: mrTotalPacks,
        downloads: mrDl.total,
      },
    },
    families: entries,
  };

  const previous = existsSync(LATEST_PATH)
    ? JSON.parse(readFileSync(LATEST_PATH, "utf8"))
    : null;
  const delta = previous ? maxRelativeDelta(previous, dataset) : Infinity;
  console.log(previous ? `Largest metric change: ${(delta * 100).toFixed(2)}%` : "No previous dataset");

  if (!FORCE && delta < THRESHOLD) {
    console.log(`Below ${THRESHOLD * 100}% threshold — not writing.`);
    return;
  }

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(LATEST_PATH, JSON.stringify(dataset, null, 1));
  const day = dataset.generatedAt.slice(0, 10);
  const snapshot = {
    date: day,
    families: Object.fromEntries(entries.map((e) => [e.key, {
      cf: { mods: e.cf.mods, modpacks: e.cf.modpacks, dl: e.cf.downloads },
      mr: { mods: e.mr.mods, modpacks: e.mr.modpacks, dl: e.mr.downloads },
    }])),
  };
  writeFileSync(resolve(SNAPSHOT_DIR, `${day}.json`), JSON.stringify(snapshot));
  console.log(`Wrote data/latest.json and data/snapshots/${day}.json`);
}

/** Largest relative change across per-family headline metrics. */
function maxRelativeDelta(
  prev: { families: FamilyEntry[]; totals?: unknown },
  next: { families: FamilyEntry[] },
) {
  if (!prev.totals) return Infinity;
  const prevByKey = new Map(prev.families.map((f) => [f.key, f]));
  let max = 0;
  for (const f of next.families) {
    const p = prevByKey.get(f.key);
    if (!p) return Infinity; // new version family is always substantial
    for (const platform of ["cf", "mr"] as const) {
      for (const metric of ["mods", "modpacks", "downloads"] as const) {
        const a = p[platform][metric];
        const b = f[platform][metric];
        if (a !== b) max = Math.max(max, Math.abs(b - a) / Math.max(a, 1));
      }
    }
  }
  return max;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
