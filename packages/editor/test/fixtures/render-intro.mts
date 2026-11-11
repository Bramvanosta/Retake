/**
 * Render the first frames of the synthetic run of a render workspace with an intro component, in a process of its own
 * (network-guard.test.ts): a render that fails mid-way leaves Remotion's encoder pipe to reject with EPIPE after the
 * failure — this process ignores it (as the jobs worker does), the test runner would count it.
 * Args: <workspace root> <component id> <open|guard> <out.mp4>. Prints one JSON line: {ok, error?, warnings}.
 */
import { PERSON_POLICY } from '@retake/core';
import { loadProject } from '@retake/core/io';
import { planRun, renderPlan } from '@retake/editor';
import type { RenderNetwork } from '@retake/editor';

process.on('unhandledRejection', (e) => {
  if ((e as NodeJS.ErrnoException)?.code !== 'EPIPE') throw e;
});
const [root, component, network, out, cacheDir] = process.argv.slice(2);
const project = await loadProject('demo', root);
const planned = await planRun({ workPolicy: PERSON_POLICY, project, run: 'latest', root, overrides: { intro: true, components: { intro: component } } });
try {
  const res = await renderPlan({ workPolicy: PERSON_POLICY, plan: planned.plan, out, root, cacheDir, network: network as RenderNetwork, frameRange: [0, 5], concurrency: 2 });
  process.stdout.write(`${JSON.stringify({ ok: true, warnings: res.warnings })}\n`);
} catch (e) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: (e as Error).message, warnings: [] })}\n`);
}
// A failed render leaves Remotion timers waiting on the refused download (up to its 90 s timeout): do not wait for them.
process.exit(0);
