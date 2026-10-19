// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  adapter: cloudflare(),
  vite: {
    // Pre-bundle these at dev-server start. mediabunny is only imported dynamically (on first MP4
    // export), so without this Vite discovers it late and that first import 404s after a restart.
    optimizeDeps: {
      include: ['mediabunny', '@mediapipe/tasks-vision'],
    },
  },
});
