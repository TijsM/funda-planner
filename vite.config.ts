import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* Static build. The engine has no server dependency yet, so the GitHub Pages
   deploy stays exactly as it is — see docs/ARCHITECTURE.md for when this moves. */
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@engine': new URL('./src/engine', import.meta.url).pathname,
      '@shell': new URL('./src/shell', import.meta.url).pathname,
      '@state': new URL('./src/state', import.meta.url).pathname,
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
