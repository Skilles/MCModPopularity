/**
 * Exact CurseForge counts for version families over the 10k search cap.
 *
 * The search API caps any query's totalCount at 10,000, but each category
 * partition of a family is far smaller than that — so this script pages
 * through every category of each capped family, collects the actual project
 * ids, and counts the deduplicated union. Overlap between categories doesn't
 * matter because real ids are deduped.
 *
 * Writes data/cf-exact.json; fetch-data uses it (when < 8 days old) instead
 * of estimating, dropping the ~ marker. Intended to run weekly — a full run
 * is ~15-20k requests (~35 min).
 */
import { writeFileSync } from "node:fs";
import {
  CF_CAP, CF_EXACT_PATH, CF_LOADERS, CLASS_MODS, CLASS_MODPACKS, cfSearchFactory,
  fetchCfCategoryIds, fetchCfTypeIds, fetchReleaseFamilies, makeCfClient, makeMrClient,
  type CfExact, type Client,
} from "./shared";

const mr = makeMrClient();
const cf: Client = makeCfClient(100);
const { cfSearch, cfCount } = cfSearchFactory(cf);

let requests = 0;
const countedSearch = async (params: Record<string, string | number>) => {
  requests++;
  return cfSearch(params);
};

/** Page a sub-cap window of a slice, collecting project ids. */
async function pageInto(
  ids: Set<number>,
  params: Record<string, string | number>,
  total: number,
  sortOrder: "asc" | "desc" = "desc",
  sortField = 6,
) {
  const pageSize = 50;
  for (let index = 0; index < total && index + pageSize <= CF_CAP; index += pageSize) {
    const page = await countedSearch({ ...params, sortField, sortOrder, pageSize, index })
      .catch(() => null);
    if (!page || page.data.length === 0) break;
    for (const mod of page.data) ids.add(mod.id);
  }
}

/**
 * Exact distinct-project count of a capped slice via category enumeration.
 * `clean` is false when some sub-slice exceeded even a two-direction page
 * (> 20k rows) — the result undercounts and must not be treated as exact.
 */
async function enumerateSlice(
  classId: number,
  categoryIds: number[],
  baseParams: Record<string, string | number>,
  label: string,
) {
  const ids = new Set<number>();
  let clean = true;
  for (const categoryId of categoryIds) {
    const params = { ...baseParams, classId, categoryId };
    const total = await cfCount(params);
    requests++;
    if (total === 0) continue;
    if (total < CF_CAP) {
      await pageInto(ids, params, total);
      continue;
    }
    // a whole category over 10k inside one family — split by loader, and page
    // capped loader slices from both ends of the sort (reaches 20k)
    console.warn(`  ${label}: category ${categoryId} is capped, splitting by loader`);
    for (const loaderId of Object.values(CF_LOADERS)) {
      const loaderParams = { ...params, modLoaderType: loaderId };
      const n = await cfCount(loaderParams);
      requests++;
      if (n === 0) continue;
      if (n < CF_CAP) {
        await pageInto(ids, loaderParams, n);
        continue;
      }
      // Still capped: page from both ends of the release-date sort (near-unique
      // keys, so the two windows provably cover slices up to 20k). If the
      // windows don't meet, the slice is bigger than 20k and undercounts.
      const newest = new Set<number>();
      const oldest = new Set<number>();
      await pageInto(newest, loaderParams, CF_CAP, "desc", 11);
      await pageInto(oldest, loaderParams, CF_CAP, "asc", 11);
      const overlaps = [...newest].some((id) => oldest.has(id));
      if (!overlaps && newest.size >= CF_CAP - 100 && oldest.size >= CF_CAP - 100) {
        console.warn(`  ${label}: category ${categoryId} loader ${loaderId} exceeds 20k rows — not fully coverable`);
        clean = false;
      }
      for (const id of newest) ids.add(id);
      for (const id of oldest) ids.add(id);
    }
  }
  return { count: ids.size, clean };
}

async function main() {
  const { families } = await fetchReleaseFamilies(mr);
  const cfTypeId = await fetchCfTypeIds(cf);
  const categoryIds = {
    [CLASS_MODS]: await fetchCfCategoryIds(cf, CLASS_MODS),
    [CLASS_MODPACKS]: await fetchCfCategoryIds(cf, CLASS_MODPACKS),
  };

  const out: CfExact = { updatedAt: new Date().toISOString(), families: {} };
  for (const [key] of families) {
    const typeId = cfTypeId.get(key);
    if (!typeId) continue;
    const base = { gameVersionTypeId: typeId };
    const entry: { mods?: number; modpacks?: number } = {};

    for (const [classId, field] of [[CLASS_MODS, "mods"], [CLASS_MODPACKS, "modpacks"]] as const) {
      const total = await cfCount({ ...base, classId });
      requests++;
      if (total < CF_CAP) continue; // fetch-data already gets these exactly
      const started = Date.now();
      const { count, clean } = await enumerateSlice(classId, categoryIds[classId], base, `${key} ${field}`);
      const secs = Math.round((Date.now() - started) / 1000);
      if (clean) {
        entry[field] = count;
        console.log(`${key} ${field}: ${count} exact (${secs}s, ${requests} requests so far)`);
      } else {
        console.log(`${key} ${field}: enumeration incomplete (${count}+ found, ${secs}s) — leaving estimated`);
      }
    }
    if (entry.mods != null || entry.modpacks != null) out.families[key] = entry;
  }

  writeFileSync(CF_EXACT_PATH, JSON.stringify(out, null, 1));
  console.log(`Wrote data/cf-exact.json (${Object.keys(out.families).length} families, ${requests} requests)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
