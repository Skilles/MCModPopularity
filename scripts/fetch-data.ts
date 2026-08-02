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
/** Window for the "actively maintained" metric. */
const ACTIVE_DAYS = 90;
/** Top Modrinth mods per family whose full file history is fetched for the
 *  file-accurate activity metric (deduped across families before fetching). */
const ACTIVITY_SAMPLE = 150;
/** How many exact (<10k) slices to measure the category-overlap factor on. */
const CALIBRATION_SAMPLES = 3;

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

interface Activity { sampled: number; active: number }
interface PlatformStats {
  mods: number;
  modpacks: number;
  /** True when a CurseForge count exceeded the 10k cap and was estimated
   *  from category partitions calibrated against exact slices. */
  modsApprox?: boolean;
  /** Downloads summed over the deduped sweeps, mods + modpacks. */
  downloads: number;
}
interface FamilyEntry {
  key: string;
  /** Release date of the newest version in the family (for sorting). */
  date: string;
  cf: PlatformStats & { loaders: Record<Loader, number> };
  mr: PlatformStats & { loaders: Record<Loader, number>; activity: Activity };
  versions: { v: string; date: string; cf: PlatformStats; mr: PlatformStats & { activity: Activity } }[];
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
interface MrVersionFile { game_versions: string[]; date_published: string }

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
  orderedIds?: string[],
) {
  const q = encodeURIComponent(JSON.stringify(facets));
  for (let offset = 0; offset < top; offset += 100) {
    const page = await mr<MrSearch>(
      `${MODRINTH}/search?limit=100&offset=${offset}&index=downloads&facets=${q}`,
    ).catch(() => null);
    if (!page || page.hits.length === 0) break;
    for (const hit of page.hits) {
      out.set(hit.project_id, { downloads: hit.downloads, versions: new Set(hit.versions) });
      orderedIds?.push(hit.project_id);
    }
  }
}

/**
 * File-accurate activity: which release versions did each sampled project
 * publish a file for within the ACTIVE_DAYS window, and which does it
 * support at all. One request per unique project.
 */
async function fetchProjectActivity(ids: Set<string>, activeSinceIso: string) {
  const supported = new Map<string, Set<string>>();
  const active = new Map<string, Set<string>>();
  let done = 0;
  for (const id of ids) {
    const files = await mr<MrVersionFile[]>(`${MODRINTH}/project/${id}/version`).catch(() => null);
    done++;
    if (done % 500 === 0) console.log(`  activity sample: ${done}/${ids.size} projects`);
    if (!files) continue;
    const sup = new Set<string>();
    const act = new Set<string>();
    for (const f of files) {
      for (const v of f.game_versions) {
        sup.add(v);
        if (f.date_published >= activeSinceIso) act.add(v);
      }
    }
    supported.set(id, sup);
    active.set(id, act);
  }
  return { supported, active };
}

// ---------------------------------------------------------------- curseforge

interface CfSearch { data: CfMod[]; pagination: { totalCount: number } }
interface CfMod { id: number; downloadCount: number; latestFilesIndexes: { gameVersion: string }[] }
interface CfVersionType { id: number; name: string }
interface CfCategory { id: number; name: string }

const cfSearch = (params: Record<string, string | number>) => {
  const q = new URLSearchParams({ gameId: String(MC_GAME_ID) });
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  return cf<CfSearch>(`${CURSEFORGE}/mods/search?${q}`);
};
const cfCount = async (params: Record<string, string | number>) =>
  (await cfSearch({ ...params, pageSize: 1 })).pagination.totalCount;

/** Per-class category ids and the measured category-overlap factor
 *  (mods carry ~2.3 categories on average, so partition sums overcount). */
const cfCategories = new Map<number, number[]>();
const cfOverlapFactor = new Map<number, number>();

async function cfLoadCategories(classId: number) {
  const cats = await cf<{ data: CfCategory[] }>(
    `${CURSEFORGE}/categories?gameId=${MC_GAME_ID}&classId=${classId}`,
  );
  cfCategories.set(classId, cats.data.map((c) => c.id));
}

async function cfCategorySum(params: Record<string, string | number>, classId: number) {
  let sum = 0;
  for (const catId of cfCategories.get(classId)!) {
    let n = await cfCount({ ...params, categoryId: catId });
    if (n >= CF_CAP && !("modLoaderType" in params)) {
      // rare: a single category over 10k — sub-partition by loader
      n = 0;
      for (const id of Object.values(CF_LOADERS)) {
        n += Math.min(await cfCount({ ...params, categoryId: catId, modLoaderType: id }), CF_CAP);
      }
    }
    sum += Math.min(n, CF_CAP);
  }
  return sum;
}

/**
 * Measure the category-overlap factor per class on slices with exact totals:
 * factor = (sum of per-category counts) / (true total). Applied to estimate
 * capped counts from their category sums.
 */
async function cfCalibrate(classId: number, versions: string[]) {
  const factors: number[] = [];
  for (const v of versions) {
    if (factors.length >= CALIBRATION_SAMPLES) break;
    const exact = await cfCount({ classId, gameVersion: v });
    if (exact < 500 || exact >= CF_CAP * 0.95) continue;
    const sum = await cfCategorySum({ classId, gameVersion: v }, classId);
    if (sum > 0) factors.push(sum / exact);
  }
  const factor = factors.length
    ? factors.reduce((a, b) => a + b, 0) / factors.length
    : 2.3; // fallback near the measured typical value
  cfOverlapFactor.set(classId, factor);
  console.log(`  class ${classId} category-overlap factor: ${factor.toFixed(2)} (${factors.length} samples)`);
}

/**
 * Exact when under the 10k cap; otherwise estimated from category-partition
 * sums divided by the measured overlap factor.
 */
async function cfCountUncapped(params: Record<string, string | number>, classId: number) {
  const total = await cfCount({ ...params, classId });
  if (total < CF_CAP) return { count: total, approx: false };
  const sum = await cfCategorySum({ ...params, classId }, classId);
  const factor = cfOverlapFactor.get(classId)!;
  return { count: Math.max(Math.round(sum / factor), CF_CAP), approx: true };
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

  console.log("Fetching CurseForge version types and categories...");
  const versionTypes = (await cf<{ data: CfVersionType[] }>(
    `${CURSEFORGE}/games/${MC_GAME_ID}/version-types`,
  )).data;
  const cfTypeId = new Map<string, number>();
  for (const vt of versionTypes) {
    const m = vt.name.match(/^Minecraft ([\d.]+)$/);
    if (m) cfTypeId.set(m[1], vt.id);
  }
  await cfLoadCategories(CLASS_MODS);
  await cfLoadCategories(CLASS_MODPACKS);

  console.log("Calibrating CurseForge category-overlap factors...");
  // Spread candidate slices across eras; cfCalibrate keeps the first few
  // whose exact totals are usable.
  const calibrationPool = releases.filter((_, i) => i % 4 === 0).map((t) => t.version);
  await cfCalibrate(CLASS_MODS, calibrationPool);
  await cfCalibrate(CLASS_MODPACKS, calibrationPool);

  const activeSinceIso = new Date(Date.now() - ACTIVE_DAYS * 86_400_000).toISOString();

  console.log("Running download sweeps (global + per-family, deduped by project)...");
  const mrProjects = new Map<string | number, SweptProject>();
  const cfProjects = new Map<string | number, SweptProject>();
  /** Per family: Modrinth mod ids ordered by downloads (activity sample frame). */
  const familyTopIds = new Map<string, string[]>();
  const mrSweeps = (async () => {
    await mrSweepInto(mrProjects, [typeFacet("mod")], SWEEP_MODS);
    await mrSweepInto(mrProjects, [typeFacet("modpack")], SWEEP_MODPACKS);
    for (const [key, members] of families) {
      const vf = versionsFacet(members.map((m) => m.version));
      const ordered: string[] = [];
      await mrSweepInto(mrProjects, [typeFacet("mod"), vf], FAMILY_SWEEP_MODS, ordered);
      familyTopIds.set(key, ordered.slice(0, ACTIVITY_SAMPLE));
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

  console.log("Fetching file-level activity for sampled Modrinth mods...");
  const sampleIds = new Set<string>();
  for (const ids of familyTopIds.values()) for (const id of ids) sampleIds.add(id);
  console.log(`  ${sampleIds.size} unique projects across ${familyTopIds.size} family samples`);
  const activity = await fetchProjectActivity(sampleIds, activeSinceIso);

  function activityFor(versionsOfInterest: string[], sampleFrame: string[]): Activity {
    let sampled = 0;
    let active = 0;
    for (const id of sampleFrame) {
      const sup = activity.supported.get(id);
      if (!sup || !versionsOfInterest.some((v) => sup.has(v))) continue;
      sampled++;
      const act = activity.active.get(id);
      if (act && versionsOfInterest.some((v) => act.has(v))) active++;
    }
    return { sampled, active };
  }

  console.log("Fetching global project counts...");
  const [mrTotalMods, mrTotalPacks, cfTotalMods, cfTotalPacks] = await Promise.all([
    mrCount([typeFacet("mod")]),
    mrCount([typeFacet("modpack")]),
    cfCountUncapped({}, CLASS_MODS),
    cfCountUncapped({}, CLASS_MODPACKS),
  ]);

  console.log("Fetching per-family and per-version counts...");
  const entries: FamilyEntry[] = [];
  for (const [key, members] of families) {
    const vs = members.map((m) => m.version);
    const typeId = cfTypeId.get(key);
    const cfFamilyParams = typeId
      ? { gameVersionTypeId: typeId }
      : { gameVersion: key }; // fallback: exact-tag match undercounts the family
    const sampleFrame = familyTopIds.get(key) ?? [];

    const [mrModCount, mrPackCount, mrLoaders, cfModCount, cfPackCount, cfLoaders] =
      await Promise.all([
        mrCount([typeFacet("mod"), versionsFacet(vs)]),
        mrCount([typeFacet("modpack"), versionsFacet(vs)]),
        Promise.all(LOADERS.map((l) =>
          mrCount([typeFacet("mod"), versionsFacet(vs), [`categories:${l}`]]))),
        cfCountUncapped(cfFamilyParams, CLASS_MODS),
        cfCountUncapped(cfFamilyParams, CLASS_MODPACKS),
        Promise.all(LOADERS.map(async (l) =>
          (await cfCountUncapped({ ...cfFamilyParams, modLoaderType: CF_LOADERS[l] }, CLASS_MODS)).count)),
      ]);

    const versions = await Promise.all(members.map(async (m) => {
      const [mrM, mrP, cfM, cfP] = await Promise.all([
        mrCount([typeFacet("mod"), versionsFacet([m.version])]),
        mrCount([typeFacet("modpack"), versionsFacet([m.version])]),
        cfCountUncapped({ gameVersion: m.version }, CLASS_MODS),
        cfCountUncapped({ gameVersion: m.version }, CLASS_MODPACKS),
      ]);
      return {
        v: m.version,
        date: m.date.slice(0, 10),
        mr: {
          mods: mrM,
          modpacks: mrP,
          activity: activityFor([m.version], sampleFrame),
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
        activity: activityFor(vs, sampleFrame),
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
    console.log(`  ${key}: cf ${cfModCount.count}${cfModCount.approx ? "~" : ""} mods, mr ${mrModCount} mods`);
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));

  const dataset = {
    generatedAt: new Date().toISOString(),
    sweepSize: { mods: SWEEP_MODS, modpacks: SWEEP_MODPACKS },
    sweptProjects: { cf: cfDl.projects, mr: mrDl.projects },
    activeDays: ACTIVE_DAYS,
    activitySample: ACTIVITY_SAMPLE,
    cfOverlapFactor: {
      mods: +cfOverlapFactor.get(CLASS_MODS)!.toFixed(3),
      modpacks: +cfOverlapFactor.get(CLASS_MODPACKS)!.toFixed(3),
    },
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
