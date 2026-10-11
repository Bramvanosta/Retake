import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@demo-studio/core': pkg('core'),
      '@demo-studio/hooks': pkg('hooks'),
      '@demo-studio/runner-web': pkg('runner-web'),
      '@demo-studio/editor': pkg('editor'),
      '@demo-studio/review': pkg('review'),
      '@demo-studio/mcp': pkg('mcp'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
