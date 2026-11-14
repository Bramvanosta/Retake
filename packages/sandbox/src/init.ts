/**
 * `retake sandbox init` (L1.8): a docker-compose sandbox scaffold in a project — `sandbox.yaml` (snapshot strategy),
 * `compose.yaml` (an `app` placeholder page, Postgres 17, Mailpit; ports on 127.0.0.1), `seed/01-demo-data.sql`,
 * `app/index.html` and a README saying how to put the application in it — plus `sandboxes: {<env>: <folder>/sandbox.yaml}`
 * in project.yaml (comments kept). Ports are picked free from 4600 upward (not used by the project's other sandboxes,
 * nothing listening). It validates and comes up as written.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SANDBOX_SCHEMA_FILE, addSandboxEntry, sandboxNames } from '@retake/core/sandbox';
import { bundleInfoOrNull, insideBundle } from '@retake/core/io';
import type { LoadedProject } from '@retake/core/model';
import type { BundleInfo } from '@retake/core/io';
import { SandboxError } from './errors.js';
import { probePort, sandboxPorts } from './ports.js';

/** The scaffold's files (next to src/ and dist/). */
export const SCAFFOLD_DIR = fileURLToPath(new URL('../scaffold/docker-compose/', import.meta.url));
/** First port tried for a new sandbox's services. */
export const INIT_BASE_PORT = 4600;
/** Environment name of a sandbox when `--env` is not given. */
export const DEFAULT_SANDBOX_ENV = 'sandbox';

export interface InitSandboxOptions {
  /** Its environment name (default `sandbox`). */
  env?: string;
  /** Write the scaffold over files already there (project.yaml entries are never changed). */
  force?: boolean;
  /** First port tried (default 4600). */
  basePort?: number;
  /** Is a port free? (default: nothing accepts a connection on it). */
  isFree?: (port: number) => Promise<boolean>;
  /**
   * Writes one file of the project (an absolute path; its folders made): the engine's project store, which writes over
   * an existing file on the version it read (`if_match`: `previous`, the text this package read, else the file as it is
   * just before) and journals it. This package writes no file itself.
   */
  write: (file: string, text: string, previous?: string) => Promise<void>;
}

export interface InitSandboxResult {
  env: string;
  /** The sandbox folder (absolute). */
  dir: string;
  /** sandbox.yaml (absolute). */
  manifest: string;
  /** Files written (absolute). */
  files: string[];
  ports: { app: number; db: number; mailpit: number };
  /** project.yaml: the entry added, or already there. */
  projectYaml: 'added' | 'kept';
}

const ENV_RE = /^[a-z0-9][a-z0-9_-]*$/;

function posixPath(p: string): string {
  return p.split(sep).join('/');
}

/**
 * How sandbox.yaml names its JSON Schema: a path relative to its folder when both are under one top-level folder,
 * else a file:// URL (a workspace on another volume, or under /tmp). L5.16c: null when the schema lies inside the
 * installed app (critique H1) — a path into the app written into the person's files breaks when the app moves or
 * updates, so the scaffold then has no `$schema` line at all.
 */
export function schemaRef(dir: string, schema: string = SANDBOX_SCHEMA_FILE, bundle: BundleInfo | null = bundleInfoOrNull()): string | null {
  if (insideBundle(schema, bundle)) return null;
  const top = (p: string) => p.split(sep).filter(Boolean)[0];
  return top(dir) === top(schema) ? posixPath(relative(dir, schema)) : pathToFileURL(schema).href;
}

/** Ports the project's environments and other sandboxes name (services, mailbox, databases), even while they are down. */
function usedPorts(project: LoadedProject, except?: string): Set<number> {
  const out = new Set<number>();
  const add = (url: string) => {
    try {
      const u = new URL(url);
      if (u.port) out.add(Number(u.port));
    } catch {
      /* not a URL */
    }
  };
  for (const s of Object.values(project.sandboxes ?? {})) {
    if (s.env === except) continue;
    for (const p of sandboxPorts(s.manifest)) out.add(p.port);
    if (s.manifest.mailbox) add(s.manifest.mailbox.url);
    for (const db of Object.values(s.manifest.databases ?? {})) add(db.url);
  }
  for (const [env, pages] of Object.entries(project.config.environments ?? {})) {
    if (env !== except) for (const url of Object.values(pages)) add(url);
  }
  return out;
}

/** `n` ports from `from` upward that are not used and free. */
async function pickPorts(n: number, from: number, used: Set<number>, isFree: (port: number) => Promise<boolean>): Promise<number[]> {
  const out: number[] = [];
  for (let port = from; out.length < n && port < 65_536; port++) {
    if (used.has(port)) continue;
    if (await isFree(port)) out.push(port);
  }
  if (out.length < n) throw new SandboxError(`no ${n} free ports from ${from} upward`);
  return out;
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(abs, base)));
    else if (e.isFile()) out.push(relative(base, abs));
  }
  return out.sort();
}

/**
 * Write a docker-compose sandbox into `project` and declare it in project.yaml. Throws SandboxError: a name already
 * taken by an environment, a sandbox of that name or any file the scaffold would write already there (without
 * `force`), no free ports.
 */
export async function initSandbox(project: LoadedProject, opts: InitSandboxOptions): Promise<InitSandboxResult> {
  const env = opts.env ?? DEFAULT_SANDBOX_ENV;
  if (!ENV_RE.test(env)) throw new SandboxError(`"${env}" cannot name an environment: lower-case letters, digits, "-" and "_"`);
  const existing = project.sandboxes?.[env];
  if (!existing && Object.hasOwn(project.config.environments ?? {}, env)) {
    throw new SandboxError(`environment ${env} already exists in project.yaml: give the sandbox another name (--env)`);
  }
  const folder = existing ? relative(project.dir, existing.dir) : env === DEFAULT_SANDBOX_ENV ? 'sandbox' : join('sandbox', env);
  const dir = join(project.dir, folder);
  const manifest = join(dir, 'sandbox.yaml');
  if (existing && !opts.force) {
    throw new SandboxError(`sandbox ${env} already exists (${relative(project.dir, existing.file)}): --force writes the scaffold over its files`);
  }
  // Any file the scaffold would write (compose.yaml, README.md, seed/, app/ — not only sandbox.yaml) is never overwritten
  // without --force.
  const scaffold = await listFiles(SCAFFOLD_DIR);
  const present = scaffold.filter((rel) => existsSync(join(dir, rel))).map((rel) => posixPath(join(folder, rel)));
  if (present.length && !opts.force) {
    throw new SandboxError(
      `${present.join(', ')} already exist${present.length === 1 ? 's' : ''}: --force writes the scaffold over ${present.length === 1 ? 'it' : 'them'}, or give the sandbox another name (--env)`,
    );
  }

  // The ports of the sandbox being rewritten (--force) are free to reuse.
  const used = usedPorts(project, existing ? env : undefined);
  const isFree = opts.isFree ?? (async (port: number) => !(await probePort(port)));
  const [app, db, mailpit] = await pickPorts(3, opts.basePort ?? INIT_BASE_PORT, used, isFree);
  const firstSandbox = sandboxNames(project).length === 0 || sandboxNames(project)[0] === env;
  const schema = schemaRef(dir);
  const values: Record<string, string> = {
    ...(schema !== null ? { __SCHEMA__: schema } : {}),
    __ENV__: env,
    __PROJECT__: project.slug,
    __ENV_FLAG__: firstSandbox ? '' : ` --env ${env}`,
    __APP_PORT__: String(app),
    __DB_PORT__: String(db),
    __MAIL_PORT__: String(mailpit),
    __DB_PASSWORD__: `pg-sandbox-${db}`,
  };
  const render = (text: string) => (schema === null ? text.replace(/^# yaml-language-server: \$schema=__SCHEMA__\n/m, '') : text).replace(/__[A-Z_]+?__/g, (k) => values[k] ?? k);

  const files: string[] = [];
  for (const rel of scaffold) {
    const target = join(dir, rel);
    await opts.write(target, render(await readFile(join(SCAFFOLD_DIR, rel), 'utf8')));
    files.push(target);
  }

  const projectFile = project.file;
  const before = await readFile(projectFile, 'utf8');
  let after: string;
  try {
    after = addSandboxEntry(before, env, `${posixPath(folder)}/sandbox.yaml`);
  } catch (e) {
    throw new SandboxError(`${(e as Error).message} — the scaffold was written to ${folder}/; add \`sandboxes: {${env}: ${posixPath(folder)}/sandbox.yaml}\` by hand`);
  }
  if (after !== before) await opts.write(projectFile, after, before);
  return { env, dir, manifest, files, ports: { app, db, mailpit }, projectYaml: after === before ? 'kept' : 'added' };
}
