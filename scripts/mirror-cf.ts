/**
 * Local mirror of every Minecraft project on CurseForge, used to compute
 * exact counts (global, per family, per patch version) that the search API
 * cannot report directly because it caps results at 10,000.
 *
 * - Seed (--seed, or automatically when no mirror exists): enumerate the
 *   whole catalog by walking category partitions, escalating capped slices
 *   down a partition ladder (category -> version type -> loader -> patch
 *   version -> two-direction release-date windows). Project ids are deduped,
 *   so partition overlap is harmless. ~20k requests.
 * - Incremental (default): page the LastUpdated sort per class until hitting
 *   projects modified before the previous sync. A few hundred requests.
 *
 * The mirror lives gzipped in data/mirror/ (gitignored; cached between CI
 * runs). Each run validates itself against a few slices with exact API
 * counts, then writes data/cf-exact.json — totals, per-family/per-version
 * counts, and full-catalog download attribution (each project's download
 * count is recorded as it is swept) that fetch-data uses instead of
 * estimating from top-N search sweeps. Download counts of projects that
 * haven't been modified since the last full seed refresh weekly.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  CF_CAP, CF_EXACT_PATH, CF_LOADERS, CLASS_MODS, CLASS_MODPACKS, DATA_DIR,
  attributeDownloads, cfSearchFactory, familyOf, fetchCfCategoryIds,
  fetchReleaseFamilies, makeCfClient, makeMrClient,
  type CfExact, type CfExactDl, type MrTag,
} from "./shared";

const MIRROR_DIR = resolve(DATA_DIR, "mirror");
const MIRROR_PATH = resolve(MIRROR_DIR, "cf-projects.json.gz");
const SEED = process.argv.includes("--seed");
/** Overlap margin when resuming incremental sync. */
const SYNC_MARGIN_MS = 2 * 3_600_000;

const mr = makeMrClient();
const cf = makeCfClient(100);
const { cfSearch, cfCount } = cfSearchFactory(cf);

let requests = 0;
const search = (params: Record<string, string | number>) => {
  requests++;
  return cfSearch(params);
};
const count = (params: Record<string, string | number>) => {
  requests++;
  return cfCount(params);
};

interface MirrorProject {
  /** classId */
  c: number;
  /** dateModified (ISO) */
  d: string;
  /** distinct game versions from latestFilesIndexes */
  v: string[];
  /** downloadCount (as of the last time this project was swept) */
  dl: number;
}
/** A seed slice that exceeded pageable coverage; counts touching it are
 *  near-exact lower bounds and get flagged approximate. */
interface DirtySlice {
  c: number;
  v?: string;
}
interface Mirror {
  syncedAt: string;
  dirty: DirtySlice[];
  projects: Record<string, MirrorProject>;
}

function loadMirror(): Mirror | null {
  if (!existsSync(MIRROR_PATH)) return null;
  const mirror = JSON.parse(gunzipSync(readFileSync(MIRROR_PATH)).toString("utf8")) as Mirror;
  // mirrors from before download counts were recorded can't be fixed
  // incrementally — treat them as missing to trigger a full reseed
  for (const p of Object.values(mirror.projects)) return p.dl !== undefined ? mirror : null;
  return null;
}
function saveMirror(mirror: Mirror) {
  mkdirSync(MIRROR_DIR, { recursive: true });
  writeFileSync(MIRROR_PATH, gzipSync(JSON.stringify(mirror), { level: 6 }));
}

function record(store: Map<number, MirrorProject>, classId: number, mod: {
  id: number; dateModified?: string; downloadCount: number;
  latestFilesIndexes: { gameVersion: string }[];
}) {
  store.set(mod.id, {
    c: classId,
    d: mod.dateModified ?? "",
    v: [...new Set(mod.latestFilesIndexes.map((f) => f.gameVersion))],
    dl: mod.downloadCount,
  });
}

// -------------------------------------------------------------------- seeding

/** Page one sort window (up to the 10k cap) of a slice into the store. */
async function pageWindow(
  store: Map<number, MirrorProject>,
  classId: number,
  params: Record<string, string | number>,
  total: number,
  sortOrder: "asc" | "desc",
  sortField = 11,
) {
  const pageSize = 50;
  for (let index = 0; index < total && index + pageSize <= CF_CAP; index += pageSize) {
    const page = await search({ ...params, classId, sortField, sortOrder, pageSize, index })
      .catch(() => null);
    if (!page || page.data.length === 0) break;
    for (const mod of page.data) record(store, classId, mod);
  }
}

interface VersionType { typeId: number; versions: string[] }

/**
 * Enumerate one slice completely, escalating through partition levels while
 * capped. Leaf slices that exceed even a two-direction window (> 20k rows)
 * get extra sort-window sweeps to minimize the miss and are recorded in
 * `dirty` so their counts are flagged approximate.
 */
async function seedSlice(
  store: Map<number, MirrorProject>,
  classId: number,
  params: Record<string, string | number>,
  ladder: ("type" | "loader" | "patch")[],
  versionTypes: VersionType[],
  dirty: DirtySlice[],
  label: string,
): Promise<void> {
  const total = await count({ ...params, classId });
  if (total === 0) return;
  if (total < CF_CAP) {
    await pageWindow(store, classId, params, total, "desc");
    return;
  }

  const [next, ...rest] = ladder;
  if (next === "type") {
    for (const vt of versionTypes) {
      await seedSlice(
        store, classId, { ...params, gameVersionTypeId: vt.typeId }, rest, versionTypes, dirty, label,
      );
    }
    // catch projects with no indexed game version (very new/empty projects)
    await pageWindow(store, classId, params, CF_CAP, "desc");
    return;
  }
  if (next === "loader") {
    for (const loaderId of Object.values(CF_LOADERS)) {
      await seedSlice(
        store, classId, { ...params, modLoaderType: loaderId }, rest, versionTypes, dirty, label,
      );
    }
    // untagged-loader files (mostly ancient projects) live in small slices,
    // but sweep the extremes of the unsplit slice as a safety net
    await pageWindow(store, classId, params, CF_CAP, "desc");
    return;
  }
  if (next === "patch") {
    const typeId = params.gameVersionTypeId as number | undefined;
    const versions = versionTypes.find((vt) => vt.typeId === typeId)?.versions ?? [];
    if (versions.length > 0) {
      for (const v of versions) {
        await seedSlice(
          store, classId, { ...params, gameVersion: v }, rest, versionTypes, dirty, label,
        );
      }
      return;
    }
    // fall through to windows when the type has no known patch list
  }

  // leaf: two windows over the near-unique release-date sort cover <= 20k
  const newest = new Map<number, MirrorProject>();
  const oldest = new Map<number, MirrorProject>();
  await pageWindow(newest, classId, params, CF_CAP, "desc");
  await pageWindow(oldest, classId, params, CF_CAP, "asc");
  const overlaps = [...newest.keys()].some((id) => oldest.has(id));
  for (const [id, p] of newest) store.set(id, p);
  for (const [id, p] of oldest) store.set(id, p);
  if (!overlaps && newest.size >= CF_CAP - 100 && oldest.size >= CF_CAP - 100) {
    console.warn(`  ${label} ${JSON.stringify(params)}: > 20k rows — sweeping extra sort windows, flagging approximate`);
    dirty.push({ c: classId, v: params.gameVersion as string | undefined });
    // more windows over other near-unique sorts (last-updated, name) shrink
    // the uncovered middle to a sliver, though coverage stays unprovable
    for (const sortField of [3, 4]) {
      await pageWindow(store, classId, params, CF_CAP, "desc", sortField);
      await pageWindow(store, classId, params, CF_CAP, "asc", sortField);
    }
  }
}

async function seed(families: Map<string, MrTag[]>) {
  console.log("Seeding full CurseForge mirror (this takes a while)...");
  // all Minecraft version types (families, snapshots, betas) with patch lists
  // where we know them from the release-family map
  const typeRes = await cf<{ data: { id: number; name: string }[] }>(
    `https://api.curseforge.com/v1/games/432/version-types`,
  );
  requests++;
  const versionTypes: VersionType[] = typeRes.data.map((vt) => {
    const m = vt.name.match(/^Minecraft ([\d.]+)$/);
    const members = m ? families.get(m[1]) : undefined;
    return { typeId: vt.id, versions: members?.map((t) => t.version) ?? [] };
  });

  const store = new Map<number, MirrorProject>();
  const dirty: DirtySlice[] = [];
  for (const classId of [CLASS_MODS, CLASS_MODPACKS]) {
    const categories = await fetchCfCategoryIds(cf, classId);
    requests++;
    for (const categoryId of categories) {
      await seedSlice(
        store, classId, { categoryId }, ["type", "loader", "patch"], versionTypes, dirty,
        `class ${classId}`,
      );
    }
    // safety net for projects with no category (should not exist, but cheap)
    await pageWindow(store, classId, {}, CF_CAP, "desc");
    console.log(`  class ${classId}: mirror at ${store.size} projects (${requests} requests)`);
  }
  if (dirty.length) console.warn(`  ${dirty.length} slices exceeded coverage — their counts will be flagged approximate`);
  return { store, dirty };
}

// -------------------------------------------------------------- incremental

async function incrementalUpdate(mirror: Mirror): Promise<boolean> {
  const since = Date.parse(mirror.syncedAt) - SYNC_MARGIN_MS;
  console.log(`Incremental sync since ${new Date(since).toISOString()}...`);
  const store = mirrorStore(mirror);
  for (const classId of [CLASS_MODS, CLASS_MODPACKS]) {
    const pageSize = 50;
    let updated = 0;
    let reachedKnown = false;
    for (let index = 0; index + pageSize <= CF_CAP && !reachedKnown; index += pageSize) {
      const page = await search({ classId, sortField: 3, sortOrder: "desc", pageSize, index })
        .catch(() => null);
      if (!page || page.data.length === 0) break;
      for (const mod of page.data) {
        record(store, classId, mod);
        updated++;
        if (mod.dateModified && Date.parse(mod.dateModified) < since) reachedKnown = true;
      }
    }
    if (!reachedKnown) {
      console.warn(`  class ${classId}: update window exceeded 10k rows — falling back to full seed`);
      return false;
    }
    console.log(`  class ${classId}: refreshed ${updated} projects`);
  }
  return true;
}

/** Adapter so record() can write straight into the mirror's plain object. */
function mirrorStore(mirror: Mirror): Map<number, MirrorProject> {
  return {
    set: (id: number, p: MirrorProject) => {
      mirror.projects[id] = p;
    },
  } as unknown as Map<number, MirrorProject>;
}

// ------------------------------------------------------------------- output

function computeCounts(mirror: Mirror, families: Map<string, MrTag[]>): CfExact {
  const out: CfExact = {
    updatedAt: new Date().toISOString(),
    source: "mirror",
    totals: { mods: 0, modpacks: 0 },
    families: {},
  };
  const perFamily = new Map<string, { mods: number; modpacks: number }>();
  const perVersion = new Map<string, { mods: number; modpacks: number }>();
  const releaseSet = new Set([...families.values()].flat().map((t) => t.version));

  for (const p of Object.values(mirror.projects)) {
    const field = p.c === CLASS_MODS ? "mods" : "modpacks";
    out.totals![field]++;
    const fams = new Set<string>();
    for (const v of p.v) {
      if (!releaseSet.has(v)) continue;
      fams.add(familyOf(v));
      let pv = perVersion.get(v);
      if (!pv) perVersion.set(v, (pv = { mods: 0, modpacks: 0 }));
      pv[field]++;
    }
    for (const f of fams) {
      let pf = perFamily.get(f);
      if (!pf) perFamily.set(f, (pf = { mods: 0, modpacks: 0 }));
      pf[field]++;
    }
  }

  for (const [key, members] of families) {
    const counts = perFamily.get(key);
    if (!counts) continue;
    out.families[key] = {
      ...counts,
      versions: Object.fromEntries(
        members
          .filter((m) => perVersion.has(m.version))
          .map((m) => [m.version, { ...perVersion.get(m.version)! }]),
      ),
    };
  }

  // download attribution over the whole catalog — reaches the long tail that
  // fetch-data's top-N search sweeps cannot
  const dl = attributeDownloads(
    Object.values(mirror.projects).map((p) => ({ downloads: p.dl ?? 0, versions: p.v })),
    releaseSet,
  );
  const dlRecord = (raw: Map<string, number>, weighted: Map<string, number>) =>
    Object.fromEntries(
      [...raw].map(([k, v]): [string, CfExactDl] =>
        [k, { dl: v, dlW: Math.round(weighted.get(k) ?? 0) }]),
    );
  out.downloads = {
    projects: dl.projects,
    total: dl.total,
    families: dlRecord(dl.perFamily, dl.perFamilyW),
    versions: dlRecord(dl.perVersion, dl.perVersionW),
  };

  // slices that exceeded pageable coverage are lower bounds, not exact
  for (const d of mirror.dirty ?? []) {
    const flag = d.c === CLASS_MODS ? ("modsApprox" as const) : ("modpacksApprox" as const);
    out.totals![flag] = true;
    if (!d.v) continue;
    const fam = out.families[familyOf(d.v)];
    if (!fam) continue;
    fam[flag] = true;
    const ver = fam.versions?.[d.v];
    if (ver) ver[flag] = true;
  }
  return out;
}

/** Compare mirror-derived counts against slices the API can count exactly. */
async function validate(exact: CfExact) {
  const checks: { classId: number; version: string }[] = [
    { classId: CLASS_MODS, version: "1.17.1" },
    { classId: CLASS_MODS, version: "1.15.1" },
    { classId: CLASS_MODS, version: "1.9.4" },
    { classId: CLASS_MODPACKS, version: "1.14.4" },
    { classId: CLASS_MODPACKS, version: "1.17.1" },
  ];
  console.log("Validating mirror against exact API slices...");
  let worst = 0;
  for (const check of checks) {
    const api = await count({ classId: check.classId, gameVersion: check.version });
    if (api >= CF_CAP) continue;
    const field = check.classId === CLASS_MODS ? "mods" : "modpacks";
    const mine = exact.families[familyOf(check.version)]?.versions?.[check.version]?.[field] ?? 0;
    const diff = api > 0 ? Math.abs(mine - api) / api : 0;
    worst = Math.max(worst, diff);
    console.log(`  ${check.version} ${field}: api ${api}, mirror ${mine} (${(diff * 100).toFixed(2)}% off)`);
  }
  if (worst > 0.01) console.warn("  mirror deviates > 1% from the API on some slices");
  return worst;
}

// --------------------------------------------------------------------- main

async function main() {
  const { families } = await fetchReleaseFamilies(mr);

  let mirror = SEED ? null : loadMirror();
  if (mirror) {
    const ok = await incrementalUpdate(mirror);
    if (!ok) mirror = null;
  }
  if (!mirror) {
    const { store, dirty } = await seed(families);
    mirror = { syncedAt: "", dirty, projects: Object.fromEntries(store) };
  }
  mirror.syncedAt = new Date().toISOString();
  saveMirror(mirror);
  console.log(`Mirror: ${Object.keys(mirror.projects).length} projects (${requests} requests)`);

  const exact = computeCounts(mirror, families);
  await validate(exact);
  writeFileSync(CF_EXACT_PATH, JSON.stringify(exact, null, 1));
  const famCount = Object.keys(exact.families).length;
  console.log(`Wrote data/cf-exact.json (totals + ${famCount} families, per-version counts, downloads over ${exact.downloads!.projects} projects)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
