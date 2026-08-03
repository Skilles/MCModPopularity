# MC Mod Popularity

Static Astro + React site charting the most popular Minecraft versions and mod
loaders by mod/modpack counts and downloads on CurseForge and Modrinth.
Deployed to GitHub Pages, data refreshed daily by GitHub Actions.

## Conventions

- Package manager: **pnpm** (never npm/yarn).
- Commits: succinct one-line messages, authored by Bilal Madi only — **no co-author tags**.
- `CURSEFORGE_API_KEY` lives in `.env` locally (gitignored) and as a repo Actions secret.

## Architecture

- `scripts/fetch-data.ts` (`pnpm fetch-data`) — pulls both APIs, writes
  `data/latest.json` (full dataset) and `data/snapshots/DATE.json` (slim, for
  trends). Only writes when a metric moved >= 1% vs the committed data
  (`--force` overrides). CurseForge search caps results at 10,000; larger
  counts are estimated from per-category partition sums divided by a
  calibration factor (~2.3, mods carry multiple categories) measured each run
  on slices with exact totals — flagged `modsApprox`. Downloads come from
  global top-N sweeps plus per-family filtered sweeps, deduplicated by
  project id. Activity is file-accurate: the top ~150 Modrinth mods per
  family have their full version history fetched, and a mod is "active" for a
  version only if it published a file for that version in the last 90 days
  (CurseForge has no date filter).
- Popularity score (`src/lib/data.ts`): 0-100 blend of downloads 40%
  (sqrt-scaled) + mod count 32% + modpack count 8% + activity 15% +
  recency 5% (user-approved weights; recency bias reduced three times).
  Blended scores are min-max rescaled within the scored set (weakest = 0,
  strongest = 100), including per-family in drill-down. Version+loader API filters match at project
  level, so impossible combos (e.g. NeoForge on 1.16) are clamped by loader
  launch dates in `familyLoaderCounts`. The "Top loader" tile weights loader
  counts by popularity score x exp(-age/4yr) so recent versions dominate but
  popular legacy versions still contribute (`weightedTopLoader`).
- User-facing copy (tooltips, notes, tiles) stays plain-language: no
  implementation jargon like "sweeps", "calibration factors", or
  "project-level filtering".
- Version "families" group patch versions (1.20.1 -> 1.20); works for both the
  1.x and date-based (26.1) version schemes. Sorted by release date, not by
  parsing version numbers.
- `src/pages/index.astro` builds tiles + cards from `data/latest.json`;
  charts are React islands (`src/components/*.tsx`, Recharts) reading colors
  from CSS variables so theming just works.
- Theme: `data-theme` on `<html>`, set pre-paint in `Layout.astro` from
  localStorage / OS preference; light and dark tokens in
  `src/styles/global.css`. Chart palettes are colorblind-validated per mode.
- `design/` holds the original three HTML design mockups (mockup C won).
- `.github/workflows/deploy.yml` — daily cron: fetch, commit data if changed,
  build, deploy to Pages. Push events skip the fetch and just redeploy.

## Development

Dev server: `astro dev --background` (manage with `astro dev stop/status/logs`).
Full docs: https://docs.astro.build
