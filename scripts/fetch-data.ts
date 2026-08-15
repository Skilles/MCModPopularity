/**
 * Fetches mod/modpack popularity data from CurseForge and Modrinth,
 * aggregates it per Minecraft version family, and writes:
 *   - data/latest.json          (full dataset the site builds from)
 *   - data/snapshots/DATE.json  (slim daily snapshot for trend charts)
 *
 * Files are only written when any headline metric moved >= 1% since the
 * last committed dataset (pass --force to write regardless).
 *
 * CurseForge counts over the 10k search cap come from data/cf-exact.json
 * (weekly ID-level enumeration, exact) when fresh; otherwise they are
 * estimated from category-partition sums divided by the category-per-mod
 * factor measured on this run's swept projects, and flagged `modsApprox`.
 * CurseForge downloads likewise come from cf-exact.json's full-catalog
 * attribution when fresh, falling back to this run's top-N sweeps.
 *
 * Requires CURSEFORGE_API_KEY (read from env, falling back to .env).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  CF_CAP, CF_LOADERS, CLASS_MODS, CLASS_MODPACKS, LATEST_PATH, LOADERS, MODRINTH,
  SNAPSHOT_DIR, attributeDownloads, cfSearchFactory, familyOf, fetchCfCategoryIds,
  fetchCfTypeIds, fetchReleaseFamilies, makeCfClient, makeMrClient, readCfExact,
  type CfSearch, type Loader,
} from "./shared";

const FORCE = process.argv.includes("--force");
const THRESHOLD = 0.01;

/** Modrinth sweeps page every query to the search index's 10k result window
 *  (globally and per family); families over the window get an extra
 *  per-loader partition pass. Projects are deduped by id before attribution,
 *  so together this covers nearly the whole catalog. */
const MR_WINDOW = 10_000;
/** CurseForge sweep depths (top projects by downloads). These only feed the
 *  category-factor measurement and the download fallback for when
 *  cf-exact.json is stale — fresh runs take downloads from the mirror's
 *  full-catalog attribution instead. */
const SWEEP_MODS = 10_000;
const SWEEP_MODPACKS = 5_000;
const FAMILY_SWEEP_MODS = 2_000;
const FAMILY_SWEEP_MODPACKS = 500;
/** Window for the "actively maintained" metric. */
const ACTIVE_DAYS = 90;
/** Top Modrinth mods per family whose full file history is fetched for the
 *  file-accurate activity metric (deduped across families before fetching). */
const ACTIVITY_SAMPLE = 150;

const mr = makeMrClient();
const cf = makeCfClient();
const { cfSearch, cfCount } = cfSearchFactory(cf);

// ------------------------------------------------------------------- shapes

interface Activity { sampled: number; active: number }
interface PlatformStats {
  mods: number;
  modpacks: number;
  /** True when a CurseForge count exceeded the 10k cap and was estimated
   *  (no fresh exact enumeration available for it). */
  modsApprox?: boolean;
  /** Downloads summed over the deduped sweeps, mods + modpacks. */
  downloads: number;
  /** Downloads split evenly across each project's supported versions —
   *  the popularity score's input (charts show raw `downloads`). */
  downloadsWeighted: number;
}
interface FamilyEntry {
  key: string;
  /** Release date of the newest version in the family (for sorting). */
  date: string;
  cf: PlatformStats & { loaders: Record<Loader, number> };
  mr: PlatformStats & { loaders: Record<Loader, number>; activity: Activity };
  versions: { v: string; date: string; cf: PlatformStats; mr: PlatformStats & { activity: Activity } }[];
}

/** Swept projects deduped by id across the global and per-family sweeps. */
interface SweptProject { downloads: number; versions: Set<string>; categories: number; classId?: number }

// ------------------------------------------------------------------ modrinth

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
      out.set(hit.project_id, {
        downloads: hit.downloads,
        versions: new Set(hit.versions),
        categories: 0,
      });
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

const cfCategories = new Map<number, number[]>();

/**
 * Category-per-project factor, measured per (class, family) from this run's
 * swept projects — capped counts are estimated as categorySum / factor.
 * Falls back to the class-wide sweep average when a family's sample is thin.
 */
const catFactor = new Map<string, { sum: number; n: number }>();
const FACTOR_MIN_SAMPLE = 100;

function recordCatFactors(projects: Map<string | number, SweptProject>, releaseSet: Set<string>) {
  for (const p of projects.values()) {
    if (!p.categories || p.classId === undefined) continue;
    const keys = [`${p.classId}:*`];
    for (const f of new Set([...p.versions].filter((v) => releaseSet.has(v)).map(familyOf))) {
      keys.push(`${p.classId}:${f}`);
    }
    for (const k of keys) {
      const e = catFactor.get(k) ?? { sum: 0, n: 0 };
      e.sum += p.categories;
      e.n++;
      catFactor.set(k, e);
    }
  }
}

function factorFor(classId: number, familyKey?: string) {
  const fam = familyKey ? catFactor.get(`${classId}:${familyKey}`) : undefined;
  const pick = fam && fam.n >= FACTOR_MIN_SAMPLE ? fam : catFactor.get(`${classId}:*`);
  return pick && pick.n > 0 ? pick.sum / pick.n : 2.3;
}

async function cfCategorySum(params: Record<string, string | number>, classId: number) {
  let sum = 0;
  for (const catId of cfCategories.get(classId)!) {
    let n = await cfCount({ ...params, classId, categoryId: catId });
    if (n >= CF_CAP && !("modLoaderType" in params)) {
      // rare: a single category over 10k — sub-partition by loader
      n = 0;
      for (const id of Object.values(CF_LOADERS)) {
        n += Math.min(await cfCount({ ...params, classId, categoryId: catId, modLoaderType: id }), CF_CAP);
      }
    }
    sum += Math.min(n, CF_CAP);
  }
  return sum;
}

/**
 * Exact when under the 10k cap; otherwise estimated from category-partition
 * sums divided by the sweep-measured category factor.
 */
async function cfCountUncapped(
  params: Record<string, string | number>,
  classId: number,
  familyKey?: string,
) {
  const total = await cfCount({ ...params, classId });
  if (total < CF_CAP) return { count: total, approx: false };
  const sum = await cfCategorySum(params, classId);
  const factor = factorFor(classId, familyKey);
  return { count: Math.max(Math.round(sum / factor), CF_CAP), approx: true };
}

async function cfSweepInto(
  out: Map<string | number, SweptProject>,
  params: Record<string, string | number>,
  top: number,
  classId: number,
) {
  const pageSize = 50;
  for (let index = 0; index + pageSize <= Math.min(top, CF_CAP); index += pageSize) {
    const page = await cfSearch({ ...params, classId, sortField: 6, sortOrder: "desc", pageSize, index })
      .catch((): CfSearch | null => null);
    if (!page || page.data.length === 0) break;
    for (const mod of page.data) {
      out.set(mod.id, {
        downloads: mod.downloadCount,
        versions: new Set(mod.latestFilesIndexes.map((f) => f.gameVersion)),
        categories: new Set(mod.categories.map((c) => c.id)).size,
        classId,
      });
    }
  }
}

// ---------------------------------------------------------------------- main

async function main() {
  console.log("Fetching Minecraft release versions from Modrinth...");
  const { releases, families } = await fetchReleaseFamilies(mr);
  const releaseSet = new Set(releases.map((t) => t.version));
  console.log(`${releases.length} release versions in ${families.size} families`);

  console.log("Fetching CurseForge version types and categories...");
  const cfTypeId = await fetchCfTypeIds(cf);
  cfCategories.set(CLASS_MODS, await fetchCfCategoryIds(cf, CLASS_MODS));
  cfCategories.set(CLASS_MODPACKS, await fetchCfCategoryIds(cf, CLASS_MODPACKS));

  const cfExact = readCfExact();
  console.log(cfExact
    ? `Using exact CurseForge counts from ${cfExact.updatedAt.slice(0, 10)}`
    : "No fresh cf-exact.json — capped counts will be estimated");

  const activeSinceIso = new Date(Date.now() - ACTIVE_DAYS * 86_400_000).toISOString();

  console.log("Running download sweeps (global + per-family, deduped by project)...");
  const mrProjects = new Map<string | number, SweptProject>();
  const cfProjects = new Map<string | number, SweptProject>();
  /** Per family: Modrinth mod ids ordered by downloads (activity sample frame). */
  const familyTopIds = new Map<string, string[]>();
  const mrSweeps = (async () => {
    await mrSweepInto(mrProjects, [typeFacet("mod")], MR_WINDOW);
    await mrSweepInto(mrProjects, [typeFacet("modpack")], MR_WINDOW);
    for (const [key, members] of families) {
      const vf = versionsFacet(members.map((m) => m.version));
      const ordered: string[] = [];
      await mrSweepInto(mrProjects, [typeFacet("mod"), vf], MR_WINDOW, ordered);
      familyTopIds.set(key, ordered.slice(0, ACTIVITY_SAMPLE));
      if (ordered.length >= MR_WINDOW) {
        // family exceeds the search window — per-loader partitions reach most
        // of the tail (only loader-untagged projects past 10k stay missed)
        for (const l of LOADERS) {
          await mrSweepInto(mrProjects, [typeFacet("mod"), vf, [`categories:${l}`]], MR_WINDOW);
        }
      }
      await mrSweepInto(mrProjects, [typeFacet("modpack"), vf], MR_WINDOW);
    }
  })();
  const cfSweeps = (async () => {
    await cfSweepInto(cfProjects, {}, SWEEP_MODS, CLASS_MODS);
    await cfSweepInto(cfProjects, {}, SWEEP_MODPACKS, CLASS_MODPACKS);
    for (const [key] of families) {
      const typeId = cfTypeId.get(key);
      if (!typeId) continue;
      await cfSweepInto(cfProjects, { gameVersionTypeId: typeId }, FAMILY_SWEEP_MODS, CLASS_MODS);
      await cfSweepInto(cfProjects, { gameVersionTypeId: typeId }, FAMILY_SWEEP_MODPACKS, CLASS_MODPACKS);
    }
  })();
  await Promise.all([mrSweeps, cfSweeps]);
  const mrDl = attributeDownloads(mrProjects.values(), releaseSet);
  const exactDl = cfExact?.downloads;
  const cfDl = exactDl
    ? {
        perVersion: new Map(Object.entries(exactDl.versions).map(([v, d]) => [v, d.dl])),
        perVersionW: new Map(Object.entries(exactDl.versions).map(([v, d]) => [v, d.dlW])),
        perFamily: new Map(Object.entries(exactDl.families).map(([f, d]) => [f, d.dl])),
        perFamilyW: new Map(Object.entries(exactDl.families).map(([f, d]) => [f, d.dlW])),
        total: exactDl.total,
        projects: exactDl.projects,
      }
    : attributeDownloads(cfProjects.values(), releaseSet);
  recordCatFactors(cfProjects, releaseSet);
  console.log(exactDl
    ? `  CurseForge downloads from full mirror catalog (${cfDl.projects} projects), swept ${mrDl.projects} Modrinth projects`
    : `  swept ${cfDl.projects} CurseForge / ${mrDl.projects} Modrinth projects (no fresh mirror downloads)`);
  console.log(`  measured category factors: mods ${factorFor(CLASS_MODS).toFixed(2)}, modpacks ${factorFor(CLASS_MODPACKS).toFixed(2)}`);

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
    cfExact?.totals
      ? Promise.resolve({ count: cfExact.totals.mods, approx: !!cfExact.totals.modsApprox })
      : cfCountUncapped({}, CLASS_MODS),
    cfExact?.totals
      ? Promise.resolve({ count: cfExact.totals.modpacks, approx: !!cfExact.totals.modpacksApprox })
      : cfCountUncapped({}, CLASS_MODPACKS),
  ]);

  console.log("Fetching per-family and per-version counts...");
  const entries: FamilyEntry[] = [];
  for (const [key, members] of families) {
    const vs = members.map((m) => m.version);
    const typeId = cfTypeId.get(key);
    const cfFamilyParams: Record<string, string | number> = typeId
      ? { gameVersionTypeId: typeId }
      : { gameVersion: key }; // fallback: exact-tag match undercounts the family
    const sampleFrame = familyTopIds.get(key) ?? [];
    const exact = cfExact?.families[key];

    const [mrModCount, mrPackCount, mrLoaders, cfModCount, cfPackCount, cfLoaders] =
      await Promise.all([
        mrCount([typeFacet("mod"), versionsFacet(vs)]),
        mrCount([typeFacet("modpack"), versionsFacet(vs)]),
        Promise.all(LOADERS.map((l) =>
          mrCount([typeFacet("mod"), versionsFacet(vs), [`categories:${l}`]]))),
        exact?.mods != null
          ? Promise.resolve({ count: exact.mods, approx: !!exact.modsApprox })
          : cfCountUncapped(cfFamilyParams, CLASS_MODS, key),
        exact?.modpacks != null
          ? Promise.resolve({ count: exact.modpacks, approx: !!exact.modpacksApprox })
          : cfCountUncapped(cfFamilyParams, CLASS_MODPACKS, key),
        Promise.all(LOADERS.map(async (l) =>
          (await cfCountUncapped({ ...cfFamilyParams, modLoaderType: CF_LOADERS[l] }, CLASS_MODS, key)).count)),
      ]);

    const versions = await Promise.all(members.map(async (m) => {
      const exactV = exact?.versions?.[m.version];
      const [mrM, mrP, cfM, cfP] = await Promise.all([
        mrCount([typeFacet("mod"), versionsFacet([m.version])]),
        mrCount([typeFacet("modpack"), versionsFacet([m.version])]),
        exactV
          ? Promise.resolve({ count: exactV.mods, approx: !!exactV.modsApprox })
          : cfCountUncapped({ gameVersion: m.version }, CLASS_MODS, key),
        exactV
          ? Promise.resolve({ count: exactV.modpacks, approx: !!exactV.modpacksApprox })
          : cfCountUncapped({ gameVersion: m.version }, CLASS_MODPACKS, key),
      ]);
      return {
        v: m.version,
        date: m.date.slice(0, 10),
        mr: {
          mods: mrM,
          modpacks: mrP,
          activity: activityFor([m.version], sampleFrame),
          downloads: mrDl.perVersion.get(m.version) ?? 0,
          downloadsWeighted: Math.round(mrDl.perVersionW.get(m.version) ?? 0),
        },
        cf: {
          mods: cfM.count,
          ...(cfM.approx || cfP.approx ? { modsApprox: true } : {}),
          modpacks: cfP.count,
          downloads: cfDl.perVersion.get(m.version) ?? 0,
          downloadsWeighted: Math.round(cfDl.perVersionW.get(m.version) ?? 0),
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
        downloadsWeighted: Math.round(mrDl.perFamilyW.get(key) ?? 0),
        loaders: Object.fromEntries(LOADERS.map((l, i) => [l, mrLoaders[i]])) as Record<Loader, number>,
      },
      cf: {
        mods: cfModCount.count,
        ...(cfModCount.approx || cfPackCount.approx ? { modsApprox: true } : {}),
        modpacks: cfPackCount.count,
        downloads: cfDl.perFamily.get(key) ?? 0,
        downloadsWeighted: Math.round(cfDl.perFamilyW.get(key) ?? 0),
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
    cfExactFrom: cfExact?.updatedAt ?? null,
    cfCategoryFactor: {
      mods: +factorFor(CLASS_MODS).toFixed(3),
      modpacks: +factorFor(CLASS_MODPACKS).toFixed(3),
    },
    totals: {
      cf: {
        mods: cfTotalMods.count,
        ...(cfTotalMods.approx || cfTotalPacks.approx ? { modsApprox: true } : {}),
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
