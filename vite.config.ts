import { defineConfig } from 'vite';
import { cp, mkdir, readFile } from 'node:fs/promises';
export default defineConfig({
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: { target: 'es2022' },
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
