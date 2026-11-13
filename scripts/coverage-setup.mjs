/**
 * vitest setupFiles entry of `node scripts/coverage.mjs` only (vitest.config.ts adds it when RETAKE_COVERAGE_RAW is
 * set): V8's precise block coverage of the test worker, taken through the inspector and written to RETAKE_COVERAGE_RAW
 * when the file ends. vitest's forks are killed at the end of a run, so NODE_V8_COVERAGE never writes theirs; the
 * processes a test starts (the CLI, MCP servers, job workers from dist/) write their own through NODE_V8_COVERAGE.
 * Only the scripts of packages/<name>/src or dist are kept, each with its source once (its inline source map maps it
 * back to the TypeScript lines).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const dir = process.env.RETAKE_COVERAGE_RAW;
const g = globalThis;
if (dir && !g.__retakeCoverage) {
  const session = new Session();
  session.connect();
  g.__retakeCoverage = {
    session,
    ready: (async () => {
      await session.post('Profiler.enable');
      await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    })(),
  };
}

afterAll(async () => {
  if (!dir) return;
  const { session, ready } = g.__retakeCoverage;
  await ready;
  const taken = await session.post('Profiler.takePreciseCoverage');
  const result = taken.result.filter((x) => x.url && !x.url.includes('node_modules') && /\/(packages|apps)\/[^/]+\/(src|dist)\//.test(x.url));
  mkdirSync(join(dir, 'src'), { recursive: true });
  if (result.length) {
    await session.post('Debugger.enable');
    for (const x of result) {
      try {
        const { scriptSource } = await session.post('Debugger.getScriptSource', { scriptId: x.scriptId });
        const h = createHash('sha1').update(scriptSource).digest('hex');
        x.src = h;
        if (!existsSync(join(dir, 'src', `${h}.js`))) writeFileSync(join(dir, 'src', `${h}.js`), scriptSource);
      } catch {
        // A script V8 no longer holds: its counts are left out.
      }
    }
    await session.post('Debugger.disable');
  }
  writeFileSync(join(dir, `coverage-w${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify({ result }));
});
