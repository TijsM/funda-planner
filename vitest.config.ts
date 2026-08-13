import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@engine': path.resolve(__dirname, 'src/engine') } },
  test: { environment: 'node', include: ['tests/unit/**/*.test.ts'] },
});
