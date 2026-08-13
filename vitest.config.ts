import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: { alias: { '@engine': dir('./src/engine') } },
  test: { environment: 'node', include: ['tests/unit/**/*.test.ts'] },
});
