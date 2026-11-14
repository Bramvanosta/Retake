/** Small text helpers shared by the CLI's output and the engine's messages (one wording for both). */
import type { UpResult } from '@retake/sandbox/types';

/** 850 → "850 ms", 4210 → "4.2 s", 75000 → "1 m 15 s". */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} m ${String(s).padStart(2, '0')} s`;
}

/** "started fixture · healthy 1/1" / "running · healthy 3/3". */
export function sandboxUpText(up: Pick<UpResult, 'started' | 'kept'>): string {
  const total = up.started.length + up.kept.length;
  const what = up.started.length ? `started ${up.started.join(', ')}${up.kept.length ? `, kept ${up.kept.join(', ')}` : ''}` : 'running';
  return `${what} · healthy ${total}/${total}`;
}
