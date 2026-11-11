/**
 * L5.15 (critique H2): render the first frames of the synthetic run at `scale: 3` (5760×3240, past VideoToolbox's
 * 4096-pixel side) on the GPU path, in a process of its own with NO unhandled-rejection handler of its own — as a
 * `retake render` runs: the render's own guard (editor guardEncoderPipe) is what keeps a broken encoder pipe from
 * crashing it (render-gpu.test.ts). Args: <workspace root> <out.mp4> <cacheDir> <auto|force-videotoolbox>.
 * Prints one JSON line: {ok, error?, warnings, path, encoding, guarded: the unhandled-rejection handlers the render left}.
 */
import { PERSON_POLICY } from '@retake/core';
import { loadProject } from '@retake/core/io';
import { planRun, renderPlan } from '@retake/editor';

const [root, out, cacheDir, mode] = process.argv.slice(2);
const project = await loadProject('demo', root);
const planned = await planRun({ workPolicy: PERSON_POLICY, project, run: 'latest', root, overrides: { scale: 3 } });
try {
  const res = await renderPlan({
    workPolicy: PERSON_POLICY,
    plan: planned.plan,
    out,
    root,
    cacheDir,
    frameRange: [0, 5],
    concurrency: 2,
    settings: { gl: 'auto', encoder: 'auto' },
    ...(mode === 'force-videotoolbox' ? { seams: { encoder: 'h264_videotoolbox' as const } } : {}),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, warnings: res.warnings, path: res.path, encoding: res.encoding, width: planned.plan.width, height: planned.plan.height, guarded: process.listenerCount('unhandledRejection') })}\n`);
} catch (e) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: (e as Error).message, warnings: [] })}\n`);
}
process.exit(0);
