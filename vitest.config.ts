import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));
const kit = fileURLToPath(new URL('./packages/components/src/kit/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@demo-studio/core': pkg('core'),
      '@demo-studio/hooks': pkg('hooks'),
      '@demo-studio/sandbox': pkg('sandbox'),
      // Before '@demo-studio/components': the first matching alias wins and that one would also match '…/kit'.
      '@demo-studio/components/kit': kit,
      '@demo-studio/runner-web': pkg('runner-web'),
      '@demo-studio/components': pkg('components'),
      '@demo-studio/editor': pkg('editor'),
      '@demo-studio/review': pkg('review'),
      '@demo-studio/engine': pkg('engine'),
      '@demo-studio/mcp': pkg('mcp'),
      '@demo-studio/ui': pkg('ui'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // Browser + ffmpeg tests are timing-sensitive: cap parallel files so a 4-CPU machine is not saturated.
    poolOptions: { forks: { maxForks: 2 } },
  },
});
