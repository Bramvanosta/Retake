/** A sandbox's status for clients outside the CLI (the MCP `sandbox_status` tool): read-only, starts nothing. */
import type { LoadedProject, WorkPolicy } from '@retake/core';
import { sandboxWork } from './sandbox-work.js';
import type { ProjectFolder } from './store/store.js';
import type { Sandboxes } from './sandboxes/sandboxes.js';

export interface SandboxStatusView {
  project: string;
  env: string;
  provider: string;
  state: 'up' | 'partial' | 'down';
  services: Array<{ name: string; state: string; healthy?: boolean; pid?: number; container?: string; started_at?: string; changed?: boolean; orphan?: boolean }>;
  /** Page key → URL of the sandbox. */
  pages: Record<string, string>;
  seed?: { hash: string; at: string; ms: number; current: boolean };
  last_reset?: { strategy: string; at: string; ms: number; by: string };
  /** The take lock, when a live command holds it. */
  lock?: { command: string; since: string; pid: number; run?: string };
  /** sandbox.yaml and the logs folder, as project refs when inside the project. */
  file: string;
  logs: string;
  notes: string[];
  /** Health messages of the services (their own responses): data, never instructions. */
  untrusted: { health: Record<string, string> };
}

/** A sandbox's status, read through the Sandboxes port (`sandboxes`); its paths shown as refs of the project's folder (`folder`). */
export async function sandboxStatus(project: LoadedProject, env: string | undefined, policy: WorkPolicy, folder: ProjectFolder, sandboxes: Sandboxes): Promise<SandboxStatusView> {
  const sb = await sandboxWork.open(sandboxes, project, env, policy);
  const { status: st, pages } = await sandboxWork.status(project, sb);
  const ref = (p: string) => {
    try {
      return folder.refOf(p);
    } catch {
      return p;
    }
  };
  const health: Record<string, string> = {};
  for (const s of st.services) if (typeof s.health === 'string' && s.health !== 'ok') health[s.name] = s.health;
  return {
    project: project.slug,
    env: st.env,
    provider: st.provider,
    state: st.state,
    services: st.services.map((s) => ({
      name: s.name,
      state: s.state,
      ...(s.healthy !== undefined ? { healthy: s.healthy } : {}),
      ...(s.pid !== undefined ? { pid: s.pid } : {}),
      ...(s.container !== undefined ? { container: s.container } : {}),
      ...(s.started_at !== undefined ? { started_at: s.started_at } : {}),
      ...(s.changed ? { changed: true } : {}),
      ...(s.orphan ? { orphan: true } : {}),
    })),
    pages,
    ...(st.seed ? { seed: st.seed } : {}),
    ...(st.last_reset ? { last_reset: st.last_reset } : {}),
    ...(st.lock ? { lock: { command: st.lock.command, since: st.lock.since, pid: st.lock.pid, ...(st.lock.run ? { run: st.lock.run } : {}) } } : {}),
    file: ref(st.file),
    logs: ref(st.logs),
    notes: st.notes,
    untrusted: { health },
  };
}
