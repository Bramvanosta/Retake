/**
 * A sandbox's seed and the reset around it: the seed steps (hook phase `seed`: http / sql / shell run by
 * @demo-studio/hooks — relative to sandbox.yaml, on the sandbox's own databases, never asked to confirm a destructive
 * step, nothing rolled back — and `exec` steps run by the provider), then the mailbox emptied (Mailpit), and the pending
 * rollbacks recorded on the sandbox's environment marked superseded (replaying them would act on the new data).
 *
 * What a reset rewrites must be the sandbox's own: the database of a sql step and the mailbox it empties are served by
 * a service of the sandbox (a port its compose project publishes, or one its process service listens on) — or marked
 * `external: true` in sandbox.yaml (the sandbox's alone, though it does not start it). Anything else is refused before
 * the reset changes anything: a `localhost:5432` or `localhost:8025` may be another stack's.
 */
import { rmSync } from 'node:fs';
import { isIP } from 'node:net';
import { interpolateDeep, isHostAllowed, normalizeHost, prefetchSecrets, protectedBy, protectedHostMessage, redact, resolveEnvironment, runAccess, secretForms, shellHostRefs } from '@demo-studio/core';
import type { HookStep, LoadedProject, LoadedSandbox, SeedStep } from '@demo-studio/core';
import { Journal, databaseTarget, hookFingerprint, runHooks, supersedePendingJournals } from '@demo-studio/hooks';
import type { HookContext, HookResult } from '@demo-studio/hooks';
import { SandboxError, errorMessage, interrupted } from './errors.js';
import { pinnedAddress, pinnedRequest } from './health.js';
import type { Provider, ProviderContext, SandboxLog } from './provider.js';

/** The plain secrets of a sandbox — its accounts' passwords, its databases' — masked in what a seed prints. */
export function sandboxSecrets(sandbox: Pick<LoadedSandbox, 'secrets' | 'manifest'>): string[] {
  const out = Object.values(sandbox.secrets ?? {}).flat();
  for (const db of Object.values(sandbox.manifest.databases ?? {})) {
    if (db.url.includes('{{')) continue;
    try {
      const pw = databaseTarget(db.url).password;
      if (pw) out.push(pw);
    } catch {
      /* validation reports it */
    }
  }
  return out;
}

/** A function masking these secret values (and their encoded forms) as *** in a text. */
export function masker(secrets: readonly string[]): (text: string) => string {
  const forms = [...new Set(secrets.flatMap((v) => secretForms(v)))].sort((a, b) => b.length - a.length);
  return forms.length ? (text) => redact(text, forms) : (text) => text;
}

/**
 * The hosts an exec seed step names (its rendered command and env values), checked like a shell hook's: each one a
 * service of the compose files (reachable inside the compose network) or allowed for the project (localhost, the
 * pages, allow_hosts), and never a host of a production or read-only environment (L1.7). A host computed inside the
 * container (`$VAR`, `$(…)`) cannot be seen from here. Throws SandboxError seed.
 */
export function checkExecHosts(pctx: Pick<ProviderContext, 'project' | 'sandbox'>, command: string, env: Record<string, string>, services: readonly string[]): void {
  const access = runAccess(resolveEnvironment(pctx.project, pctx.sandbox.env), false, pctx.project);
  for (const r of shellHostRefs(command, { env })) {
    if (r.unresolved) continue;
    const host = normalizeHost(r.host);
    if (!services.includes(host) && !isHostAllowed(host, pctx.project)) {
      throw new SandboxError(`refusing an exec step that names host ${host} (${r.via}): a seed reaches the sandbox's services, localhost and the project's allowed hosts only`, 'seed');
    }
    const hit = protectedBy(host, access);
    if (hit) throw new SandboxError(protectedHostMessage('an exec seed step', hit, access, host), 'seed');
  }
}

/** The port a URL (http or a database's) names; null when it names none that can be read. */
function portOf(url: string, database: boolean): number | null {
  try {
    if (database) return databaseTarget(url).port;
    const u = new URL(url);
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return null;
  }
}

/**
 * Before the seed rewrites them: the database of every sql step (`db`, default the first) must be served by a service
 * of the sandbox, or marked `external: true`. Throws SandboxError seed.
 */
export async function checkSeedDatabases(pctx: ProviderContext, provider: Provider): Promise<void> {
  const dbs = pctx.sandbox.manifest.databases ?? {};
  const keys = new Set<string>();
  for (const step of pctx.sandbox.manifest.seed ?? []) {
    if (!('sql' in step)) continue;
    const key = typeof step.sql === 'object' ? step.sql.db : undefined;
    keys.add(key ?? Object.keys(dbs)[0] ?? '');
  }
  for (const key of keys) {
    const db = dbs[key];
    if (!db || db.external) continue; // an unknown key fails in the step itself
    const port = portOf(db.url, true);
    if (port === null) continue;
    try {
      await provider.servedBy(pctx, port, {
        what: `database ${key}`,
        why: `the seed rewrites it at every reset, so it must be the sandbox's own: serve it from the sandbox, or add \`external: true\` to databases.${key} in sandbox.yaml if that database is the sandbox's alone`,
      });
    } catch (e) {
      if (e instanceof SandboxError) throw new SandboxError(e.message, 'seed');
      throw e;
    }
  }
}

/**
 * Before a reset empties it: the mailbox (Mailpit, `clear` not false) must be served by a service of the sandbox, or
 * marked `external: true`. Throws SandboxError.
 */
export async function checkMailbox(pctx: ProviderContext, provider: Provider): Promise<void> {
  const m = pctx.sandbox.manifest.mailbox;
  if (!m || m.clear === false || m.provider !== 'mailpit' || m.external) return;
  const port = portOf(m.url, false);
  if (port === null) return;
  await provider.servedBy(pctx, port, {
    what: `the mailbox ${m.url}`,
    why: "every reset empties it, so it must be the sandbox's own: serve it from the sandbox, add `external: true` to the mailbox in sandbox.yaml if it is the sandbox's alone, or `clear: false` to keep its messages",
  });
}

/** port → address of the sandbox's own databases (provider.address: docker-compose publishes them), for sql steps. */
async function databaseAddresses(pctx: ProviderContext, provider: Provider): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!provider.address) return out;
  for (const db of Object.values(pctx.sandbox.manifest.databases ?? {})) {
    if (db.external) continue;
    const port = portOf(db.url, true);
    if (port === null || out.has(port)) continue;
    const address = await provider.address(pctx, port);
    if (address) out.set(port, address);
  }
  return out;
}

export interface SeedResult {
  steps: number;
  ms: number;
}

function failure(r: HookResult, total: number): string {
  return `seed step ${r.index + 1}/${total} (${r.description}) ${r.status === 'refused' ? 'was refused' : 'failed'}: ${r.error ?? r.status}`;
}

/**
 * Run the seed steps in order (consecutive hook steps in one runHooks call, `exec` steps through the provider). The
 * seed journal (`seed-journal.json`) is started afresh each time. Throws SandboxError seed at the first failure.
 */
export async function runSeed(
  pctx: ProviderContext,
  provider: Provider,
  opts: { by: string; log: SandboxLog; signal?: AbortSignal; running?: Set<number> },
): Promise<SeedResult> {
  const { project, sandbox, paths } = pctx;
  const steps: SeedStep[] = sandbox.manifest.seed ?? [];
  const t0 = Date.now();
  if (!steps.length) return { steps: 0, ms: 0 };
  const env = resolveEnvironment(project, sandbox.env);
  const ctx: HookContext = {
    project,
    env,
    vars: { ...(project.config.vars ?? {}) },
    runId: opts.by,
    baseDir: sandbox.dir,
    saved: {},
    // Read-write (a sandbox always is); the hosts of production / read-only environments stay protected.
    access: runAccess(env, false, project),
    log: (level, msg) => opts.log(level === 'error' ? 'debug' : level, msg),
    // Ctrl-C stops a running shell step's process group; a second one kills it (Sandbox.killStartedSync).
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.running ? { running: opts.running } : {}),
  };
  // Trust `mcp` (L3.1): a shell step needs a human approval, bound to its position among ALL the seed steps (runHooks
  // sees a batch between exec steps: its index is moved to the seed's).
  let offset = 0;
  const trust = pctx.seedTrust;
  if (trust?.trust === 'mcp') {
    ctx.trust = 'mcp';
    const confirm = trust.confirm;
    ctx.confirmDestructive = async (description, reason, request) => {
      if (!confirm) return false;
      const index = offset + request.index;
      return confirm(description, reason, { ...request, index, fingerprint: hookFingerprint(request.hook, { phase: 'seed', index, env: request.env, ...(request.files ? { files: request.files } : {}) }) });
    };
  }
  // sql steps reach the sandbox's own databases on the address Docker publishes them on (never `localhost`: another
  // container may publish the same port on ::1); `external: true` ones as their URL says.
  const addresses = await databaseAddresses(pctx, provider);
  if (addresses.size) ctx.connectAddress = (host, port) => (isIP(host.replace(/^\[|\]$/g, '')) ? undefined : addresses.get(port));
  rmSync(paths.seedJournal, { force: true });
  const journal = await Journal.open(paths.seedJournal);
  let batch: HookStep[] = [];
  let done = 0;
  const flush = async () => {
    if (!batch.length) return;
    offset = done;
    const res = await runHooks(batch, ctx, { phase: 'seed', journal });
    if (!res.ok && opts.signal?.aborted) throw interrupted(`sandbox ${sandbox.env} seed`);
    if (!res.ok) {
      const bad = res.results.find((r) => !r.ok) ?? res.results[res.results.length - 1];
      throw new SandboxError(`sandbox ${sandbox.env}: ${failure({ ...bad, index: done + (bad?.index ?? 0) }, steps.length)}`, 'seed');
    }
    done += batch.length;
    batch = [];
  };
  for (const step of steps) {
    if (opts.signal?.aborted) throw interrupted(`sandbox ${sandbox.env} seed`);
    if ('exec' in step) {
      await flush();
      if (!provider.exec) throw new SandboxError(`sandbox ${sandbox.env}: exec seed steps need provider docker-compose`, 'seed');
      try {
        await provider.exec(pctx, step.exec);
      } catch (e) {
        // Ctrl-C stays an interrupt (exit 130), not a failed seed.
        if (e instanceof SandboxError && e.code === 'interrupted') throw e;
        throw new SandboxError(`sandbox ${sandbox.env}: seed step ${done + 1}/${steps.length} (exec in ${step.exec.service}) ${e instanceof SandboxError && e.code === 'seed' ? 'was refused' : 'failed'}: ${errorMessage(e)}`, 'seed');
      }
      done++;
      continue;
    }
    batch.push(step as HookStep);
  }
  await flush();
  if (opts.signal?.aborted) throw interrupted(`sandbox ${sandbox.env} seed`);
  return { steps: steps.length, ms: Date.now() - t0 };
}

/**
 * Empty the sandbox's mailbox (Mailpit `DELETE /api/v1/messages`; the fixture's Mailpit-compatible API too) unless
 * `clear: false`. An http mailbox has no generic way to be emptied: 'not-mailpit'. `address` says where the sandbox's
 * own services publish a port (docker-compose: 127.0.0.1…): a mailbox on a loopback host name is reached there, never
 * where `localhost` resolves first. Throws SandboxError on failure.
 */
export async function clearMailbox(
  project: LoadedProject,
  sandbox: LoadedSandbox,
  address?: (port: number) => Promise<string | undefined>,
): Promise<'cleared' | 'kept' | 'none' | 'not-mailpit'> {
  const m = sandbox.manifest.mailbox;
  if (!m) return 'none';
  if (m.clear === false) return 'kept';
  if (m.provider !== 'mailpit') return 'not-mailpit';
  const headers = m.headers ? (interpolateDeep(m.headers, { vars: project.config.vars ?? {}, secrets: (await prefetchSecrets(m.headers)).resolver }) as Record<string, string>) : {};
  const url = `${m.url.replace(/\/+$/, '')}/api/v1/messages`;
  const port = m.external || !address ? null : portOf(m.url, false);
  const known = port === null ? undefined : await address!(port);
  const pinned = known === undefined ? undefined : pinnedAddress(url, new Map([[port!, known]]));
  let status: number;
  try {
    if (pinned) status = (await pinnedRequest(url, { address: pinned, method: 'DELETE', headers, timeoutMs: 10_000 })).status;
    else {
      const res = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) });
      await res.body?.cancel().catch(() => undefined);
      status = res.status;
    }
  } catch (e) {
    const err = e as Error & { code?: string; cause?: { code?: string } };
    throw new SandboxError(`sandbox ${sandbox.env}: the mailbox could not be emptied (DELETE ${url}): ${err.cause?.code ?? err.code ?? err.message}`);
  }
  if (status < 200 || status > 299) throw new SandboxError(`sandbox ${sandbox.env}: the mailbox could not be emptied (DELETE ${url}): HTTP ${status}`);
  return 'cleared';
}

/** After a reset: pending rollbacks recorded on the sandbox's environment will never be replayed. */
export async function supersede(projectDir: string, env: string, by: string, log: SandboxLog): Promise<number> {
  const changed = await supersedePendingJournals(projectDir, env, by);
  const n = changed.reduce((s, c) => s + c.count, 0);
  if (n) log('info', `${n} pending rollback${n === 1 ? '' : 's'} of earlier runs on ${env} will not be replayed (the reset rebuilt that data)`);
  return n;
}
