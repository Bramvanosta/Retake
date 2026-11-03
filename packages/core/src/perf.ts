/**
 * One line about what a take cost and how it was filmed (L5.7, run.json `perf`): the CLI's run summary, the MCP
 * run_status summary. Never names a target (page text): scene.step only.
 */
import type { RunPerf } from './types.js';

export function perfSummary(p: RunPerf): string {
  const parts: string[] = [];
  if (p.cpu) {
    const chromium = p.cpu.browser + p.cpu.gpu + p.cpu.renderer + p.cpu.chromium_other;
    const per = (x: number) => (x / Math.max(0.001, p.seconds)).toFixed(2);
    // The tool's own process: `retake`, or `studio` in a run recorded before L5.13a (review B L8).
    const own = p.cpu.retake ?? (p.cpu as { studio?: number }).studio ?? 0;
    parts.push(`${p.cpu.cores.toFixed(2)} cores (Chromium ${per(chromium)}, encoder ${per(p.cpu.encoder)}, retake ${per(own)}${p.cpu.product !== undefined ? `, product ${per(p.cpu.product)}` : ''})`);
  }
  if (p.gpu && !p.gpu.accelerated) parts.push('no GPU');
  parts.push(`${p.frames.fps} fps${p.frames.motion_fps_min !== undefined ? ` (moves ≥ ${Math.round(p.frames.motion_fps_min)})` : ''}`);
  parts.push(p.stalls.length ? `${p.stalls.length} freeze${p.stalls.length > 1 ? 's' : ''} (cut by the edit)` : 'no freeze');
  const slow = p.transitions?.slow ?? [];
  if (p.transitions) {
    parts.push(
      slow.length
        ? `${slow.length} slow transition${slow.length > 1 ? 's' : ''}: ${slow
            .slice(0, 3)
            .map((x) => `${x.scene}.${x.step} ${(x.ms / 1000).toFixed(1)} s`)
            .join(', ')}${slow.length > 3 ? ', …' : ''}`
        : 'no slow transition',
    );
  }
  if (p.disk) parts.push(`${p.disk.run_mb < 10 ? p.disk.run_mb.toFixed(1) : Math.round(p.disk.run_mb)} MB`);
  if (!p.frame_rate_limit) parts.push('frame-rate limiter off');
  return parts.join(' · ');
}
