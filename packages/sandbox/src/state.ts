/**
 * A sandbox's state file (`.retake/sandbox/<env>/state.json`, version 1): the processes it started (pid + start
 * time: a reused pid is never taken for ours), when it was last seeded (and the seed's hash) and reset. Written
 * synchronously and atomically (a temp file renamed over it): an entry is on disk before the CLI waits for anything,
 * so a crash or a kill -9 during `up` never leaves an untracked process behind.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SandboxProvider, SandboxResetStrategy } from '@retake/core/model';
import type { Member } from './proc.js';

export const STATE_VERSION = 1;

/** A process the process provider started: the leader of its own process group (pgid = pid). */
export interface ProcessServiceState {
  kind: 'process';
  pid: number;
  /** Its start time (ISO), as `ps -o lstart` reports it: with the pid, its identity. */
  started_at: string;
  /** The command as started (shown by status). */
  command: string;
  /** The hash of its definition in sandbox.yaml (command, cwd, env): a changed one is reported. */
  hash: string;
  /** starting: spawned, not healthy yet (written before the health wait); running: healthy once. */
  status: 'starting' | 'running';
  /** The machine's boot time when it started (epoch seconds): after a reboot nothing recorded is ours. */
  boot?: number;
  /**
   * The members of its process group (pid + start time, epoch ms) once it was healthy, refreshed by each up: when the
   * leader has exited, its group is ours only if one of these still runs in it.
   */
  members?: Member[];
}

/** A service entry of another provider (docker-compose keeps none: docker knows its containers; see provider_state). */
export interface OtherServiceState {
  kind: string;
  [key: string]: unknown;
}

export type ServiceState = ProcessServiceState | OtherServiceState;

export interface SandboxState {
  version: typeof STATE_VERSION;
  env: string;
  provider: SandboxProvider;
  services: Record<string, ServiceState>;
  /** The last successful seed: the hash it was made from (core seedHash), when, how long. */
  seed?: { hash: string; at: string; ms: number };
  /** The last successful reset. */
  last_reset?: { strategy: SandboxResetStrategy; at: string; ms: number; restored: boolean; by: string };
  /** Provider-specific state (docker-compose: `compose {project, dir}`, `snapshot` — snapshot-postgres SnapshotState). */
  provider_state?: Record<string, unknown>;
}

export function isProcessService(s: ServiceState | undefined): s is ProcessServiceState {
  return s?.kind === 'process' && typeof (s as ProcessServiceState).pid === 'number';
}

export function emptyState(env: string, provider: SandboxProvider): SandboxState {
  return { version: STATE_VERSION, env, provider, services: {} };
}

/**
 * Read the state file. Missing → empty. Unreadable, malformed or of another version / provider → empty, with a note
 * (its processes cannot be trusted as ours: they are left alone and their ports reported as busy).
 */
export function readState(file: string, env: string, provider: SandboxProvider): { state: SandboxState; note?: string } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: emptyState(env, provider) };
    return { state: emptyState(env, provider), note: `cannot read ${file}: ${(e as Error).message} — starting from an empty state` };
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { state: emptyState(env, provider), note: `${file} is not valid JSON — starting from an empty state` };
  }
  const s = v as Partial<SandboxState> | null;
  if (!s || typeof s !== 'object' || s.version !== STATE_VERSION || typeof s.services !== 'object' || s.services === null) {
    return { state: emptyState(env, provider), note: `${file} is not a state file this Retake reads — starting from an empty state` };
  }
  if (s.provider !== provider) {
    return { state: emptyState(env, provider), note: `${file} was written for provider ${String(s.provider)} (sandbox.yaml now says ${provider}) — starting from an empty state` };
  }
  return { state: { ...(s as SandboxState), env } };
}

/** Write the state atomically (temp file + rename), synchronously. */
export function writeState(file: string, state: SandboxState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}
