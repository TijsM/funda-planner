import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/* Static build. The engine has no server dependency yet, so the GitHub Pages
   deploy stays exactly as it is — see docs/ARCHITECTURE.md for when this moves. */
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@engine': path.resolve(__dirname, 'src/engine'),
      '@shell': path.resolve(__dirname, 'src/shell'),
      '@state': path.resolve(__dirname, 'src/state'),
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
