import { cpSync, createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const EVIDENCE_DIR = fileURLToPath(new URL('../../evidence/verified-runs', import.meta.url));
const LOCAL_API = process.env.RETURNTRIP_API ?? 'http://127.0.0.1:4320';

const EVIDENCE_TYPES: Readonly<Record<string, string>> = {
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.patch': 'text/plain; charset=utf-8',
  '.diff': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

/**
 * Publishes the sanitized run bundles under /evidence/ without duplicating them into the app:
 * served straight from the repository in dev, copied into the output on build.
 */
function recordedEvidence(): Plugin {
  return {
    name: 'returntrip-recorded-evidence',
    configureServer(server) {
      server.middlewares.use('/evidence', (request, response, next) => {
        const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://local').pathname);
        const file = normalize(join(EVIDENCE_DIR, pathname));
        const inside = file.startsWith(`${EVIDENCE_DIR}${sep}`);
        const isFile = inside && statSync(file, { throwIfNoEntry: false })?.isFile();
        if (!isFile) return next();
        response.setHeader('content-type', EVIDENCE_TYPES[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(response);
      });
    },
    writeBundle(options) {
      if (!options.dir) return;
      cpSync(EVIDENCE_DIR, join(options.dir, 'evidence'), { recursive: true });
    },
  };
}

export default defineConfig(() => {
  const isPublic = process.env.VITE_RT_MODE === 'public';
  return {
    // A GitHub Pages project site lives under /<repo>/; everything else is served at the root.
    base: process.env.RETURNTRIP_BASE ?? '/',
    plugins: [react(), tailwindcss(), ...(isPublic ? [recordedEvidence()] : [])],
    build: {
      outDir: isPublic ? 'dist-public' : 'dist',
      emptyOutDir: true,
      sourcemap: false,
    },
    server: isPublic
      ? {}
      : {
          // The API rejects foreign Host and Origin headers, so the dev proxy presents itself as the API.
          proxy: {
            '/api': {
              target: LOCAL_API,
              changeOrigin: true,
              configure: (proxy) => {
                proxy.on('proxyReq', (proxyRequest) => {
                  if (proxyRequest.getHeader('origin')) proxyRequest.setHeader('origin', LOCAL_API);
                });
              },
            },
            '/health': { target: LOCAL_API, changeOrigin: true },
          },
        },
  };
});
