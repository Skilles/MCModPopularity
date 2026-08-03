/** Constants, HTTP clients, and API helpers shared by the data scripts. */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = resolve(ROOT, "data");
export const SNAPSHOT_DIR = resolve(DATA_DIR, "snapshots");
export const LATEST_PATH = resolve(DATA_DIR, "latest.json");
/** Exact counts for slices over the search cap, produced weekly by enumerate-cf. */
export const CF_EXACT_PATH = resolve(DATA_DIR, "cf-exact.json");

export const MODRINTH = "https://api.modrinth.com/v2";
export const CURSEFORGE = "https://api.curseforge.com/v1";
export const MC_GAME_ID = 432;
export const CLASS_MODS = 6;
export const CLASS_MODPACKS = 4471;
/** CurseForge search results are hard-capped at this count. */
export const CF_CAP = 10_000;

export const CF_LOADERS = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 } as const;
export type Loader = keyof typeof CF_LOADERS;
export const LOADERS = Object.keys(CF_LOADERS) as Loader[];

/** "1.20.1" -> "1.20", "26.1.2" -> "26.1", "1.21" -> "1.21" */
export const familyOf = (v: string) => v.split(".").slice(0, 2).join(".");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function loadDotEnv() {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export type Client = <T>(url: string) => Promise<T>;

/** Serial request queue per host with a fixed delay, retries on 429/5xx. */
export function makeClient(headers: Record<string, string>, delayMs: number): Client {
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

export function makeMrClient(): Client {
  return makeClient(
    { "User-Agent": "Skilles/MCModPopularity/1.0 (github.com/Skilles/MCModPopularity)" },
    220,
  );
}

export function makeCfClient(delayMs = 120): Client {
  loadDotEnv();
  const key = process.env.CURSEFORGE_API_KEY;
  if (!key) {
    console.error("CURSEFORGE_API_KEY is not set (env or .env)");
    process.exit(1);
  }
  return makeClient({ "x-api-key": key, "Accept": "application/json" }, delayMs);
}

// ------------------------------------------------------------------- shapes

export interface MrTag { version: string; version_type: string; date: string }
export interface CfSearch { data: CfMod[]; pagination: { totalCount: number } }
export interface CfMod {
  id: number;
  downloadCount: number;
  latestFilesIndexes: { gameVersion: string }[];
  categories: { id: number }[];
}

// ------------------------------------------------------------------ helpers

export function cfSearchFactory(cf: Client) {
  const cfSearch = (params: Record<string, string | number>) => {
    const q = new URLSearchParams({ gameId: String(MC_GAME_ID) });
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    return cf<CfSearch>(`${CURSEFORGE}/mods/search?${q}`);
  };
  const cfCount = async (params: Record<string, string | number>) =>
    (await cfSearch({ ...params, pageSize: 1 })).pagination.totalCount;
  return { cfSearch, cfCount };
}

/** Release versions grouped into families, newest data from Modrinth's tags. */
export async function fetchReleaseFamilies(mr: Client) {
  const tags = await mr<MrTag[]>(`${MODRINTH}/tag/game_version`);
  const releases = tags.filter((t) => t.version_type === "release");
  const families = new Map<string, MrTag[]>();
  for (const t of releases) {
    const f = familyOf(t.version);
    if (!families.has(f)) families.set(f, []);
    families.get(f)!.push(t);
  }
  return { releases, families };
}

/** Family key ("1.20") -> CurseForge gameVersionTypeId. */
export async function fetchCfTypeIds(cf: Client) {
  const versionTypes = await cf<{ data: { id: number; name: string }[] }>(
    `${CURSEFORGE}/games/${MC_GAME_ID}/version-types`,
  );
  const map = new Map<string, number>();
  for (const vt of versionTypes.data) {
    const m = vt.name.match(/^Minecraft ([\d.]+)$/);
    if (m) map.set(m[1], vt.id);
  }
  return map;
}

export async function fetchCfCategoryIds(cf: Client, classId: number) {
  const cats = await cf<{ data: { id: number }[] }>(
    `${CURSEFORGE}/categories?gameId=${MC_GAME_ID}&classId=${classId}`,
  );
  return cats.data.map((c) => c.id);
}

export interface CfExact {
  updatedAt: string;
  families: Record<string, { mods?: number; modpacks?: number }>;
}

export function readCfExact(maxAgeDays = 8): CfExact | null {
  if (!existsSync(CF_EXACT_PATH)) return null;
  const exact = JSON.parse(readFileSync(CF_EXACT_PATH, "utf8")) as CfExact;
  const age = Date.now() - Date.parse(exact.updatedAt);
  return age < maxAgeDays * 86_400_000 ? exact : null;
}
