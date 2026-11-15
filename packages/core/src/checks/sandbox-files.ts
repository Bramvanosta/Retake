/**
 * The files sandbox.yaml names: paths relative to it, the compose files (their services, those under `profiles:`) and
 * the compose env file (what it sets, a COMPOSE_PROFILES refused, {{compose_env:NAME}} read from it).
 */
import { dirname, join, resolve } from 'node:path';
import { parse as parseYamlText } from 'yaml';
import { needFiles } from '../file-facts.js';
import type { IssuePath } from '../issues.js';
import { errorMessage } from '../util.js';
import type { CheckContext } from './context.js';
import { isObj } from './context.js';
import { machinePath } from './project.js';

/** Compose files read when `compose.files` is absent. */
export const DEFAULT_COMPOSE_FILES: readonly string[] = ['compose.yaml'];
export const DIR_LABEL = 'the sandbox folder';

/** A path written in sandbox.yaml: relative to it. */
export function checkRelative(p: unknown, path: IssuePath, what: string, ctx: CheckContext): p is string {
  if (typeof p !== 'string') return false;
  if (machinePath(p)) {
    ctx.error(path, `${what} "${p}" only exists on this computer: write it relative to sandbox.yaml`);
    return false;
  }
  return true;
}

/** The names an env file sets (`NAME=value`, `export NAME=value`; comments and blank lines skipped). */
export function envFileKeys(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * What an env file sets, by name (`NAME=value`, `export NAME=value`), as docker compose reads the common forms: a
 * value in single quotes as it is, one in double quotes with its `\n`, `\"` and `\\` escapes, a bare one trimmed and
 * cut at an inline ` #` comment. The last line of a name wins. No `${VAR}` expansion: a value is taken as written.
 */
export function envFileValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2];
    let value: string;
    const single = /^'([^']*)'/.exec(raw);
    const double = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
    if (single) value = single[1];
    else if (double) value = double[1].replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
    else value = raw.replace(/\s+#.*$/, '').trim();
    out[m[1]] = value;
  }
  return out;
}

/** `{{compose_env:NAME}}` as a whole value: an account's username or password read from the sandbox's compose env file. */
const COMPOSE_ENV_REF = /^\s*\{\{\s*compose_env:([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}\s*$/;

/** The name a `{{compose_env:NAME}}` value reads from the sandbox's compose env file; undefined for any other value. */
export function composeEnvRef(value: unknown): string | undefined {
  return typeof value === 'string' ? COMPOSE_ENV_REF.exec(value)?.[1] : undefined;
}

/**
 * The env file of a docker-compose sandbox, absolute: `compose.env_file` (relative to sandbox.yaml), else `.env`
 * next to the first compose file when it exists (`exists`: the caller's look at the disk); undefined for none
 * (`env_file: false`, no such file, a process sandbox).
 */
export function composeEnvFilePath(dir: string, manifest: { provider?: unknown; compose?: { files?: readonly string[]; env_file?: unknown } }, exists: (p: string) => boolean): string | undefined {
  const c = manifest.compose;
  if (manifest.provider !== 'docker-compose' || c?.env_file === false) return undefined;
  if (typeof c?.env_file === 'string') return resolve(dir, c.env_file);
  const guess = join(dirname(resolve(dir, (c?.files ?? DEFAULT_COMPOSE_FILES)[0])), '.env');
  return exists(guess) ? guess : undefined;
}

/**
 * The env file of a docker-compose sandbox: a written `env_file` must exist; a `COMPOSE_PROFILES` in it (or in the
 * default `.env` next to the first compose file) is refused — docker compose would read it and start other services
 * than sandbox.yaml says (the shell's COMPOSE_* are left out for the same reason).
 */
export function checkEnvFile(c: Record<string, unknown>, composeFiles: readonly string[], ctx: CheckContext): void {
  if (!ctx.projectDir || c.env_file === false) return;
  const files = needFiles(ctx.files, 'the env file check');
  let file: string;
  let at: IssuePath;
  if (typeof c.env_file === 'string') {
    if (!checkRelative(c.env_file, ['compose', 'env_file'], 'env file', ctx)) return;
    file = resolve(ctx.projectDir, c.env_file);
    at = ['compose', 'env_file'];
    if (files.kind(file) === undefined) {
      ctx.error(at, `env file "${c.env_file}" not found in ${DIR_LABEL}`);
      return;
    }
  } else {
    if (!composeFiles.length || machinePath(composeFiles[0])) return;
    file = resolve(dirname(resolve(ctx.projectDir, composeFiles[0])), '.env');
    at = Array.isArray(c.files) ? ['compose', 'files', 0] : ['provider'];
    if (files.kind(file) === undefined) return;
  }
  let text: string;
  try {
    text = files.readText(file);
  } catch {
    ctx.error(at, `env file ${file} cannot be read`);
    return;
  }
  if (envFileKeys(text).includes('COMPOSE_PROFILES')) {
    ctx.error(
      at,
      `the env file ${typeof c.env_file === 'string' ? `"${c.env_file}"` : 'next to the compose file (.env)'} sets COMPOSE_PROFILES: docker compose would start other services than sandbox.yaml says — remove it (or give \`env_file\` another file)`,
    );
  }
}

/**
 * Why `{{compose_env:NAME}}` cannot be read (null when it can): not a docker-compose sandbox, no env file, the name not
 * set in it. Never the value. Without the sandbox's folder (a text validated alone) only the provider is checked.
 */
export function composeEnvProblem(manifest: Record<string, unknown>, name: string, ctx: CheckContext): string | null {
  const dir = ctx.projectDir;
  const ref = `{{compose_env:${name}}}`;
  if (manifest.provider !== 'docker-compose') return `${ref} reads the compose env file of a docker-compose sandbox: this one is not (use {{env:VAR}} or {{keychain:service/account}})`;
  const c = isObj(manifest.compose) ? manifest.compose : undefined;
  if (c?.env_file === false) return `${ref} reads the sandbox's compose env file, and \`compose.env_file: false\` says there is none`;
  if (!dir) return null;
  const facts = needFiles(ctx.files, 'the compose env check');
  const files = Array.isArray(c?.files) ? c.files.filter((f): f is string => typeof f === 'string') : undefined;
  const file = composeEnvFilePath(dir, { provider: 'docker-compose', compose: { ...(files?.length ? { files } : {}), env_file: c?.env_file } }, (p) => facts.kind(p) !== undefined);
  if (!file) return `${ref} reads the sandbox's compose env file, and there is none: write \`compose.env_file\`, or a .env next to the first compose file`;
  let text: string;
  try {
    text = facts.readText(file);
  } catch {
    return null; // checkEnvFile says so
  }
  return Object.hasOwn(envFileValues(text), name) ? null : `${ref}: ${name} is not set in the sandbox's compose env file (${file})`;
}

/**
 * The services the compose files declare (undefined when they cannot be read); those under `profiles:` are added to
 * `profiled` (a sandbox never starts them: compose runs without COMPOSE_PROFILES).
 */
export function composeServices(files: readonly string[], base: IssuePath, written: boolean, ctx: CheckContext, profiled: Set<string>): Set<string> | undefined {
  const out = new Set<string>();
  let complete = true;
  files.forEach((f, i) => {
    const at = written ? [...base, i] : base;
    if (!checkRelative(f, at, 'compose file', ctx)) {
      complete = false;
      return;
    }
    if (!ctx.projectDir) {
      complete = false;
      return;
    }
    const abs = resolve(ctx.projectDir, f);
    const disk = needFiles(ctx.files, 'the compose file check');
    let text: string;
    try {
      text = disk.readText(abs);
    } catch {
      ctx.error(at, `compose file "${f}" not found in ${DIR_LABEL}${written ? '' : ' (compose.files defaults to [compose.yaml])'}`);
      complete = false;
      return;
    }
    let doc: unknown;
    try {
      doc = parseYamlText(text);
    } catch (e) {
      ctx.error(at, `compose file "${f}" is not valid YAML: ${errorMessage(e).split('\n')[0]}`);
      complete = false;
      return;
    }
    if (isObj(doc) && isObj(doc.services)) {
      for (const [name, svc] of Object.entries(doc.services)) {
        out.add(name);
        if (isObj(svc) && Array.isArray(svc.profiles) && svc.profiles.length) profiled.add(name);
      }
    }
  });
  return complete ? out : undefined;
}
