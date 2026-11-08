import { defineConfig } from 'vite';
import { cp, mkdir, readFile } from 'node:fs/promises';
export default defineConfig({
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // Keep stable runtimes cacheable without pulling demand-loaded languages into startup.
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return;
          if (/\/(?:react|react-dom|scheduler)\//.test(id)) return 'react';
          if (/\/pdfjs-dist\//.test(id)) return 'pdfjs';
          if (/\/@codemirror\/(?:state|view|commands|language|search|autocomplete|legacy-modes)\//.test(id)
            || /\/@lezer\/(?:common|highlight|lr)\//.test(id)
            || /\/(?:style-mod|w3c-keyname|crelt)\//.test(id)) return 'codemirror';
        },
      },
    },
  },
  worker: { format: 'es' },
  plugins: [{
    name: 'paperdock-local-pdf-assets',
    async closeBundle() {
      await mkdir('dist/pdfjs', { recursive: true });
      for (const name of ['cmaps', 'standard_fonts', 'wasm']) {
        await cp(`node_modules/pdfjs-dist/${name}`, `dist/pdfjs/${name}`, { recursive: true });
      }
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', async (req, res, next) => {
        const relative = (req.url ?? '').split('?')[0];
        if (!/^\/(cmaps|standard_fonts|wasm)\/[A-Za-z0-9_.-]+$/.test(relative)) { next(); return; }
        try {
          res.end(await readFile(`node_modules/pdfjs-dist${relative}`));
        } catch { next(); }
      });
    },
  }],
});
