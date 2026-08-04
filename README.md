# MC Mod Popularity

Charts the most popular Minecraft versions and mod loaders, measured by
mod/modpack counts and download totals on CurseForge and Modrinth.

Static Astro + React site on GitHub Pages; a GitHub Action refreshes the data
daily and only commits when the numbers meaningfully change (>= 1%).

## Development

```sh
pnpm install
pnpm fetch-data   # needs CURSEFORGE_API_KEY in .env
pnpm dev
```

## Data notes

- Counts come from the platforms' search APIs. CurseForge caps search results
  at 10,000, so counts are computed exactly from a locally maintained mirror
  of the full Minecraft catalog; if the mirror data is stale they fall back
  to calibrated estimates, marked ~.
- Download totals sum every project reached by the sweeps: global top 10k mods
  / 5k modpacks per platform plus per-version filtered sweeps, deduplicated.
- The popularity index blends downloads (30%), mod count (25%), maintenance
  activity (25%), and version recency (20%). Activity is file-level: a mod
  counts as active for a version only if it published a file for that version
  in the last 90 days (sampled from each version's top Modrinth mods).
- A mod counts toward every Minecraft version it supports, and cross-posted
  projects count once per platform.
