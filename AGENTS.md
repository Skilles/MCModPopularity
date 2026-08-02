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
  (`--force` overrides). CurseForge search caps results at 10,000, so larger
  counts are reconstructed from per-loader partitions and flagged `modsApprox`.
  Download totals sum the top-10k mods / top-5k modpacks per platform.
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
