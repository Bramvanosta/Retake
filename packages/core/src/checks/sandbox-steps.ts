/**
 * The seed steps of a sandbox.yaml (and its reset.hooks, the same steps run at every reset): paths relative to it, no
 * rollback, no pg_dump plain output, `exec` in a compose service, the services' conflicting env, the hook checks
 * (without the destructive confirmation) and their tokens.
 */
import { resolve } from 'node:path';
import { sqlSource } from '../destructive.js';
import { needFiles } from '../file-facts.js';
import { isHostAllowed } from '../hosts.js';
import type { IssuePath } from '../issues.js';
import { shellHostRefs } from '../shell-hosts.js';
import type { LoadedProject } from '../types/project.js';
import { suggestion } from '../validation/suggest.js';
import type { CheckContext } from './context.js';
import { isObj } from './context.js';
import { checkHooks } from './hooks.js';
import { checkRelative } from './sandbox-files.js';
import { checkTokens } from './tokens.js';
import type { TokenScope } from './tokens.js';

/** A sandbox's provider (undefined when it names none). */
export type Provider = 'docker-compose' | 'process' | undefined;
/** A page of the sandbox: the service serving it, its URL and where that URL is written. */
export type SandboxPage = { service: string; url: string; path: IssuePath };

/** pg_dump's plain output (COPY … FROM stdin, psql meta-commands): sql steps cannot run it. */
function dumpOutputReason(sql: string): string | null {
  if (/\bFROM\s+stdin\s*;/i.test(sql)) return 'COPY … FROM stdin';
  const meta = /^\s*\\(connect|restrict|unrestrict|c|i|set|copy)\b/m.exec(sql);
  return meta ? `\\${meta[1]}` : null;
}

/** What the seed and reset.hooks steps are checked against. */
export interface StepsContext {
  value: Record<string, unknown>;
  provider: Provider;
  services: Record<string, unknown>;
  composeNames: Set<string> | undefined;
  profiled: ReadonlySet<string>;
  pages: ReadonlyMap<string, SandboxPage>;
  scope: TokenScope;
  /** The steps' saved names (the hook checks add to it). */
  saved: Set<string>;
  /** The environment name the sandbox becomes. */
  env: string;
  config: LoadedProject['config'] | undefined;
}

/** Seed steps (or reset.hooks): each step, the services' conflicting env, the hook checks and their tokens. */
export function checkSteps(list: unknown[], base: IssuePath, s: StepsContext, ctx: CheckContext): void {
  const { value, provider, services, composeNames, profiled, pages, scope, saved, config } = s;
  const compose = provider === 'docker-compose';
  const serviceNames = Object.keys(services);
  const pageKeys = [...pages.keys()];
  const allowConfig = {
    environments: { ...(config?.environments ?? {}), [s.env]: Object.fromEntries([...pages].map(([k, p]) => [k, p.url])) },
    allow_hosts: config?.allow_hosts,
  };
  const hookList = list.map((step, i) => checkSeedStep(step, [...base, i], { compose, composeNames, profiled, serviceNames, allowConfig }, ctx));
  // A shell step gets the `env` of the process services (a seed's `npm run db:reset` reaches the sandbox's database):
  // a variable two of them set differently is the step's to set.
  const conflicts = provider === 'process' ? conflictingServiceEnv(services) : new Map<string, string[]>();
  list.forEach((step, i) => {
    if (!conflicts.size || !isObj(step) || step.shell === undefined || ctx.broken([...base, i])) return;
    const own = isObj(step.shell) && isObj(step.shell.env) ? step.shell.env : {};
    for (const [name, by] of conflicts) {
      if (Object.hasOwn(own, name)) continue;
      ctx.error([...base, i, 'shell'], `services ${by.join(' and ')} set ${name} differently, and a shell step gets the env of the sandbox's services: set ${name} in the step's own \`env\``);
    }
  });
  checkHooks(hookList, base, ctx, {
    pages: pageKeys,
    saved,
    project: { config: allowConfig as never },
    destructiveOk: true,
    noPersonaAuth:
      "a seed runs while the data is being built: no persona is signed in yet — sign in with the product's own API and {{accounts.<persona>.username}} / {{accounts.<persona>.password}}, or move the request to a setup hook",
  });
  // Its hook steps read the sandbox's own accounts and compose env file (`exec` steps are not hooks: they do not).
  const seedScope: TokenScope = { ...scope, hookRefs: { accounts: isObj(value.accounts) ? Object.keys(value.accounts) : [] } };
  list.forEach((step, i) => {
    if (!ctx.broken([...base, i])) checkTokens(step, [...base, i], isObj(step) && step.exec !== undefined ? scope : seedScope, ctx);
  });
}

/** Variables two process services set to different values (`env` as written), with the services. */
function conflictingServiceEnv(services: Record<string, unknown>): Map<string, string[]> {
  const seen = new Map<string, Map<string, string[]>>();
  for (const [name, svc] of Object.entries(services)) {
    if (!isObj(svc) || !isObj(svc.env)) continue;
    for (const [k, v] of Object.entries(svc.env)) {
      if (typeof v !== 'string') continue;
      const byValue = seen.get(k) ?? new Map<string, string[]>();
      byValue.set(v, [...(byValue.get(v) ?? []), name]);
      seen.set(k, byValue);
    }
  }
  const out = new Map<string, string[]>();
  for (const [k, byValue] of seen) if (byValue.size > 1) out.set(k, [...byValue.values()].flat());
  return out;
}

interface SeedContext {
  compose: boolean;
  composeNames: Set<string> | undefined;
  /** Compose services under `profiles:` (never started). */
  profiled: ReadonlySet<string>;
  serviceNames: readonly string[];
  allowConfig: { environments: Record<string, Record<string, string>>; allow_hosts?: string[] };
}

/**
 * One seed step: its paths relative to sandbox.yaml, no rollback (a seed is never undone), SQL that is not a pg_dump
 * plain dump, and `exec` (docker-compose: a compose service; the hosts its command names allowed). Returns the step as
 * checkHooks reads it (null for `exec`, which is not a hook).
 */
function checkSeedStep(step: unknown, p: IssuePath, s: SeedContext, ctx: CheckContext): unknown {
  if (!isObj(step) || ctx.broken(p)) return null;
  if (isObj(step.exec)) {
    const ep: IssuePath = [...p, 'exec'];
    if (!s.compose) {
      ctx.error(ep, '`exec` runs a command inside a compose service (provider docker-compose): with provider process, write a `shell` step (with `cwd`)', { path: ep, key: true });
      return null;
    }
    const svc = step.exec.service;
    const known = s.composeNames ? [...s.composeNames] : [...s.serviceNames];
    if (typeof svc === 'string' && !known.includes(svc)) {
      ctx.error([...ep, 'service'], `unknown service "${svc}"${suggestion(svc, known)} (${s.composeNames ? 'the compose files declare' : 'services'}: ${known.join(', ') || 'none'})`);
    } else if (typeof svc === 'string' && s.profiled.has(svc)) {
      ctx.error([...ep, 'service'], `service "${svc}" has \`profiles:\` in the compose files: a sandbox never starts it, so an exec step cannot run in it — remove its \`profiles\``);
    }
    const cmd = step.exec.command;
    const text = typeof cmd === 'string' ? cmd : Array.isArray(cmd) ? cmd.filter((x) => typeof x === 'string').join(' ') : '';
    const extra = s.composeNames ?? new Set(s.serviceNames);
    for (const r of shellHostRefs(text)) {
      if (r.unresolved || extra.has(r.host) || isHostAllowed(r.host, { config: s.allowConfig as never })) continue;
      ctx.error([...ep, 'command'], `exec names host ${r.host} (${r.via}): a seed only reaches the sandbox's services, localhost and allowed hosts`);
    }
    return null;
  }
  for (const kind of ['http', 'sql', 'shell'] as const) {
    const spec = step[kind];
    if (isObj(spec) && spec.rollback !== undefined) {
      ctx.warning([...p, kind, 'rollback'], 'a seed step is never rolled back (the next reset rebuilds the data): `rollback` is ignored', { path: [...p, kind, 'rollback'], key: true });
    }
  }
  if (step.sql !== undefined) {
    const spec = step.sql as string | { file?: unknown; query?: unknown };
    const src = typeof spec === 'string' ? sqlSource(spec) : { file: typeof spec.file === 'string' ? spec.file : undefined, query: typeof spec.query === 'string' ? spec.query : undefined };
    const fp: IssuePath = typeof spec === 'string' ? [...p, 'sql'] : [...p, 'sql', 'file'];
    let text = src.query;
    if (src.file !== undefined) {
      if (!checkRelative(src.file, fp, 'SQL file', ctx)) return null;
      if (ctx.projectDir) {
        const disk = needFiles(ctx.files, 'the seed SQL check');
        try {
          text = disk.readText(resolve(ctx.projectDir, src.file));
        } catch {
          text = undefined; // reported by checkHooks
        }
      }
    }
    const dump = text === undefined ? null : dumpOutputReason(text);
    if (dump) {
      ctx.error(
        fp,
        `this SQL is pg_dump's plain output (${dump}): sql steps run SQL statements — dump with \`pg_dump --inserts\`, or load it with an \`exec\` step (psql -f inside the database's container)`,
      );
    }
  }
  if (isObj(step.shell) && step.shell.cwd !== undefined) checkRelative(step.shell.cwd, [...p, 'shell', 'cwd'], 'cwd', ctx);
  return step;
}
