import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/* fileURLToPath, not URL().pathname — the latter percent-encodes, which
   silently breaks every alias when a directory name contains a space. */
const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@engine': dir('./src/engine'),
      '@shell': dir('./src/shell'),
      '@state': dir('./src/state'),
      /* `server-only` resolves to a module whose only job is to throw, unless the
         bundler applies React's `react-server` export condition — which Vitest
         does not. Importing the BFL adapter to test its status mapping is a hard
         crash without this; the package ships the very stub that condition picks. */
      'server-only': dir('./node_modules/server-only/empty.js'),
    },
  },
  test: {
    /* node stays the default: engine.test.ts and render.test.ts are pure
       geometry and a DOM would only slow them down. The render-store tests need
       one and ask for it with a `@vitest-environment jsdom` line of their own. */
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
