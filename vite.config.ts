import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run dev` serves all pages (index, highway, roundabout).
// `SIM=highway vite build` / `SIM=roundabout vite build` produce a single,
// self-contained HTML file per simulator in dist/<sim>/ so each can be shown
// or shared on its own.
const sim = process.env.SIM;

export default defineConfig(
  sim
    ? {
        root: resolve(__dirname, `src/${sim}`),
        base: './',
        plugins: [viteSingleFile()],
        define: { __STANDALONE__: 'true' },
        build: { outDir: resolve(__dirname, `dist/${sim}`), emptyOutDir: true },
      }
    : { root: resolve(__dirname, 'src'), define: { __STANDALONE__: 'false' }, server: { open: '/index.html' } },
);
