// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://skilles.github.io',
  base: '/MCModPopularity',
  integrations: [
    react(),
    sitemap({
      // match the canonical URL's trailing slash
      serialize: (item) => ({ ...item, url: item.url.endsWith('/') ? item.url : `${item.url}/` }),
    }),
  ],
});
