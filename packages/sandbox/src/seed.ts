/**
 * A sandbox's seed and the reset around it: the seed steps (hook phase `seed`: http / sql / shell run by
 * @retake/hooks — relative to sandbox.yaml, on the sandbox's own databases, never asked to confirm a destructive
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
import { interpolateDeep, redact, secretForms } from '@retake/core/base';
import { isHostAllowed, normalizeHost, protectedBy, protectedHostMessage, resolveEnvironment, runAccess } from '@retake/core/environment';
import { shellHostRefs } from '@retake/core/hooks';
import { prefetchSecrets } from '@retake/core/io';
import type { HookStep, LoadedProject, LoadedSandbox, SeedStep } from '@retake/core/model';
import { Journal, databaseTarget, hookFingerprint, runHooks, supersedePendingJournals } from '@retake/hooks';
import type { HookContext, HookResult } from '@retake/hooks';
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
 * of the sandbox, or marked `external: true`. `of: 'reset hooks'`: the sql steps of `reset.hooks`, the same rule — they
 * run at every reset, a snapshot restored or not. Throws SandboxError seed.
 */
export async function checkSeedDatabases(pctx: ProviderContext, provider: Provider, of: 'seed' | 'reset hooks' = 'seed'): Promise<void> {
  const dbs = pctx.sandbox.manifest.databases ?? {};
  const keys = new Set<string>();
  const steps = of === 'seed' ? (pctx.sandbox.manifest.seed ?? []) : (pctx.sandbox.manifest.reset?.hooks ?? []);
  for (const step of steps) {
    if (!('sql' in step)) continue;
    const key = typeof step.sql === 'object' ? step.sql.db : undefined;
    keys.add(key ?? Object.keys(dbs)[0] ?? '');
  }
  const who = of === 'seed' ? 'the seed rewrites' : 'a reset hook rewrites';
  for (const key of keys) {
    const db = dbs[key];
    if (!db || db.external) continue; // an unknown key fails in the step itself
    const port = portOf(db.url, true);
    if (port === null) continue;
    try {
      await provider.servedBy(pctx, port, {
        what: `database ${key}`,
        why: `${who} it at every reset, so it must be the sandbox's own: serve it from the sandbox, or add \`external: true\` to databases.${key} in sandbox.yaml if that database is the sandbox's alone`,
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
  if (!provider.capabilities.address) return out;
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

function failure(r: HookResult, total: number, what = 'seed step'): string {
  return `${what} ${r.index + 1}/${total} (${r.description}) ${r.status === 'refused' ? 'was refused' : 'failed'}: ${r.error ?? r.status}`;
}

/**
 * Run the seed steps in order (consecutive hook steps in one runHooks call, `exec` steps through the provider). The
 * seed journal (`seed-journal.json`) is started afresh each time. Throws SandboxError seed at the first failure.
 */
export async function runSeed(
  pctx: ProviderContext,
  provider: Provider,
  opts: {
    by: string;
    log: SandboxLog;
    signal?: AbortSignal;
    running?: Set<number>;
    /**
     * Hotfix v0.2.5: other steps than the seed — `reset.hooks`, run at every reset (`what`: how messages name them and
     * their approvals' phase, `reset`, bound to their position among the reset hooks; `indexBase`: where their runs are
     * journaled, after the seed's positions).
     */
    steps?: SeedStep[];
    what?: 'reset hook';
    indexBase?: number;
  },
): Promise<SeedResult> {
  const { project, sandbox, paths } = pctx;
  const steps: SeedStep[] = opts.steps ?? sandbox.manifest.seed ?? [];
  const word = opts.what ?? 'seed';
  const base = opts.indexBase ?? 0;
  const t0 = Date.now();
  if (!steps.length) return { steps: 0, ms: 0 };
  const env = resolveEnvironment(project, sandbox.env);
  const ctx: HookContext = {
    project,
    policy: pctx.policy,
    env,
    vars: { ...(project.config.vars ?? {}) },
    runId: opts.by,
    baseDir: sandbox.dir,
    saved: {},
    // Read-write (a sandbox always is); the hosts of production / read-only environments stay protected.
    access: runAccess(env, false, project),
    log: (level, msg) => {
      opts.log(level === 'error' ? 'debug' : level, msg);
      pctx.progress?.note(msg);
    },
    // The seed hooks' secrets: its opener's resolver (ProviderContext.resolveSecret), as the services' are.
    resolveSecret: pctx.resolveSecret,
    // Ctrl-C stops a running shell step's process group; a second one kills it (Sandbox.killStartedSync).
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.running ? { running: opts.running } : {}),
  };
  // Trust `mcp` (L3.1): a shell step needs a human approval, bound to its position among ALL the seed steps (runHooks
  // sees a batch between exec steps: its index is moved to the seed's); a reset hook's to its position among the reset
  // hooks, under phase `reset` (L7.8).
  let offset = 0;
  const trust = pctx.seedTrust;
  const record = pctx.recordSeedRun;
  // runHooks numbers a batch's steps from 0: reported at their position among ALL the seed steps (a rollback keeps its
  // journal seq).
  // Reset hooks (hotfix v0.2.5) come after the seed's positions (`base`, as their approvals) and are journaled as `reset`.
  const phase = opts.what ? 'reset' : 'seed';
  if (record) ctx.recordRun = (r, run) => record(r.phase === 'rollback' ? r : { ...r, index: base + offset + r.index, phase }, run);
  /** An exec step run, reported like a hook step (never its command); best effort, like recordHookRun. */
  const recordExec = async (step: SeedStep, index: number, status: string, ms: number) => {
    if (!record) return;
    try {
      await record({ index: base + index, ...(step.name !== undefined ? { name: step.name } : {}), kind: 'exec', phase, status, ...(step.optional ? { optional: true } : {}), ms });
    } catch {
      // the step ran: its report is best effort
    }
  };
  if (trust?.trust === 'mcp') {
    ctx.trust = 'mcp';
    const confirm = trust.confirm;
    ctx.confirmDestructive = async (description, reason, request) => {
      if (!confirm) return false;
      const at = offset + request.index;
      const index = base + at;
      // A reset hook (L7.8) is bound to its own phase and its position within reset.hooks: its approval is never a seed
      // step's, nor a seed step's its.
      const place = opts.what ? { phase: 'reset' as const, index: at } : { phase: 'seed' as const, index };
      return confirm(description, reason, { ...request, index, fingerprint: hookFingerprint(request.hook, { ...place, env: request.env, ...(request.files ? { files: request.files } : {}) }) });
    };
  }
  // sql steps reach the sandbox's own databases on the address Docker publishes them on (never `localhost`: another
  // container may publish the same port on ::1); `external: true` ones as their URL says.
  const addresses = await databaseAddresses(pctx, provider);
  if (addresses.size) ctx.connectAddress = (host, port) => (isIP(host.replace(/^\[|\]$/g, '')) ? undefined : addresses.get(port));
  const journalFile = opts.what ? paths.resetJournal : paths.seedJournal;
  rmSync(journalFile, { force: true });
  const journal = await Journal.open(journalFile);
  let batch: HookStep[] = [];
  let done = 0;
  const flush = async () => {
    if (!batch.length) return;
    offset = done;
    const kinds = [...new Set(batch.map((b) => (b as { name?: string }).name ?? Object.keys(b as object).find((k) => k !== 'name') ?? 'step'))].join(', ');
    pctx.progress?.step(`${word} ${done + 1}${batch.length > 1 ? `–${done + batch.length}` : ''}/${steps.length}`, kinds);
    const res = await runHooks(batch, ctx, { phase: 'seed', journal });
    if (!res.ok && opts.signal?.aborted) throw interrupted(`sandbox ${sandbox.env} seed`);
    if (!res.ok) {
      const bad = res.results.find((r) => !r.ok) ?? res.results[res.results.length - 1];
      throw new SandboxError(`sandbox ${sandbox.env}: ${failure({ ...bad, index: done + (bad?.index ?? 0) }, steps.length, `${word} step`)}`, 'seed');
    }
    done += batch.length;
    batch = [];
  };
  for (const step of steps) {
    if (opts.signal?.aborted) throw interrupted(`sandbox ${sandbox.env} seed`);
    if ('exec' in step) {
      await flush();
      if (!provider.capabilities.exec) throw new SandboxError(`sandbox ${sandbox.env}: exec ${word} steps need provider docker-compose`, 'seed');
      pctx.progress?.step(`${word} ${done + 1}/${steps.length}`, `exec in ${step.exec.service}`);
      const t1 = Date.now();
      try {
        await provider.exec(pctx, step.exec);
      } catch (e) {
        const refused = e instanceof SandboxError && e.code === 'seed';
        const isInterrupt = e instanceof SandboxError && e.code === 'interrupted';
        await recordExec(step, done, isInterrupt ? 'interrupted' : refused ? 'refused' : 'failed', Date.now() - t1);
        // Ctrl-C stays an interrupt (exit 130), not a failed seed.
        if (isInterrupt) throw e;
        throw new SandboxError(`sandbox ${sandbox.env}: ${word} step ${done + 1}/${steps.length} (exec in ${step.exec.service}) ${refused ? 'was refused' : 'failed'}: ${errorMessage(e)}`, 'seed');
      }
      await recordExec(step, done, 'ok', Date.now() - t1);
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
  resolveSecret: (ref: string) => Promise<string>,
  address?: (port: number) => Promise<string | undefined>,
): Promise<'cleared' | 'kept' | 'none' | 'not-mailpit'> {
  const m = sandbox.manifest.mailbox;
  if (!m) return 'none';
  if (m.clear === false) return 'kept';
  if (m.provider !== 'mailpit') return 'not-mailpit';
  const headers = m.headers ? (interpolateDeep(m.headers, { vars: project.config.vars ?? {}, secrets: (await prefetchSecrets(m.headers, resolveSecret)).resolver }) as Record<string, string>) : {};
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
