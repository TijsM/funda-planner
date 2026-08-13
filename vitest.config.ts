import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@engine': new URL('./src/engine', import.meta.url).pathname } },
  test: { environment: 'node', include: ['tests/unit/**/*.test.ts'] },
});
