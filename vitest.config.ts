import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/* fileURLToPath, not URL().pathname — the latter percent-encodes, which
   silently breaks every alias when a directory name contains a space. */
const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: { alias: { '@engine': dir('./src/engine') } },
  test: { environment: 'node', include: ['tests/unit/**/*.test.ts'] },
});
