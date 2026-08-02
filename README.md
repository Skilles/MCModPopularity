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
  at 10,000, so larger counts are reconstructed from per-loader partitions and
  marked approximate (~).
- Download totals sum the top 10k mods and top 5k modpacks per platform by
  downloads; the long tail contributes little.
- A mod counts toward every Minecraft version it supports, and cross-posted
  projects count once per platform.
