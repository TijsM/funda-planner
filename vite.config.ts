import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/* NB: fileURLToPath, not URL().pathname — the latter percent-encodes, which
   silently breaks every alias as soon as a directory name contains a space. */
const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/* Static build. The engine has no server dependency yet, so the GitHub Pages
   deploy stays exactly as it is — see docs/ARCHITECTURE.md for when this moves. */
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@engine': dir('./src/engine'),
      '@shell': dir('./src/shell'),
      '@state': dir('./src/state'),
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
