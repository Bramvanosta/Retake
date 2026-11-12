/**
 * The sandbox readers: the manifests a project names, the files a sandbox's seed reads and their hash, and the env file
 * of a docker-compose sandbox.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { canonicalJson } from '../canonical-json.js';
import { composeEnvFilePath, composeEnvRef, envFileValues } from '../checks/sandbox.js';
import { sqlSource } from '../destructive.js';
import { issuesMessage } from '../issues.js';
import { SANDBOX_SEED_DIR, SandboxConfigError, parseSandboxYaml, sandboxAuth } from '../sandbox.js';
import type { LoadedSandbox, ProjectConfig, SandboxManifest } from '../types.js';
import { nodeFileFacts } from './file-facts.js';

/**
 * Read the manifests of project.yaml `sandboxes:` (paths relative to the project dir). Throws SandboxConfigError
 * (positioned in the manifest) when one has errors: a broken manifest fails every command of the project, like a broken
 * project.yaml. Undefined when the project declares none.
 */
export async function loadSandboxes(projectDir: string, config: ProjectConfig): Promise<Record<string, LoadedSandbox> | undefined> {
  const entries = Object.entries(config.sandboxes ?? {});
  if (entries.length === 0) return undefined;
  const out: Record<string, LoadedSandbox> = {};
  for (const [env, rel] of entries) {
    const file = resolve(projectDir, rel);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (e) {
      const why = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : `cannot be read: ${(e as Error).message}`;
      throw new SandboxConfigError(`sandbox ${env}: ${file} ${why} (project.yaml sandboxes.${env})`, [], file, env);
    }
    const { manifest, issues } = parseSandboxYaml(text, file, { env, project: { config }, files: nodeFileFacts });
    if (!manifest) throw new SandboxConfigError(issuesMessage(`sandbox ${env}`, issues, file), issues, file, env);
    const composeEnv = await accountsComposeEnv(dirname(file), manifest, env, file);
    out[env] = { env, file, dir: dirname(file), manifest, issues, ...(composeEnv ? { composeEnv } : {}), secrets: sandboxAuth(manifest, composeEnv).secrets };
  }
  return out;
}

/**
 * What the accounts' `{{compose_env:NAME}}` references read from the sandbox's compose env file: those names only.
 * Undefined when no account uses one. Throws SandboxConfigError when the file or a name is missing (never the value).
 */
export async function accountsComposeEnv(dir: string, manifest: SandboxManifest, env: string, file: string): Promise<Record<string, string> | undefined> {
  const names = new Set<string>();
  for (const a of Object.values(manifest.accounts ?? {})) for (const v of [a.username, a.password]) if (composeEnvRef(v) !== undefined) names.add(composeEnvRef(v)!);
  if (!names.size) return undefined;
  const envFile = composeEnvFilePath(dir, manifest, existsSync);
  const fail = (why: string) => new SandboxConfigError(`sandbox ${env}: ${file}: ${why}`, [], file, env);
  if (!envFile) throw fail(`{{compose_env:${[...names][0]}}} reads the sandbox's compose env file, and there is none (compose.env_file, or a .env next to the first compose file)`);
  let values: Record<string, string>;
  try {
    values = envFileValues(await readFile(envFile, 'utf8'));
  } catch (e) {
    throw fail(`the compose env file ${envFile} cannot be read: ${(e as Error).message}`);
  }
  const out: Record<string, string> = {};
  for (const n of names) {
    if (!Object.hasOwn(values, n) || values[n] === '') throw fail(`{{compose_env:${n}}}: ${n} is not set (or empty) in the compose env file (${envFile})`);
    out[n] = values[n];
  }
  return out;
}

/**
 * The files a sandbox's seed reads, absolute and sorted: the SQL files of its sql steps and every file of the
 * `seed/` folder next to sandbox.yaml (scripts a shell or exec step runs elsewhere are not seen).
 */
export async function seedFileRefs(sandbox: Pick<LoadedSandbox, 'dir' | 'manifest'>): Promise<string[]> {
  const files = new Set<string>();
  for (const step of sandbox.manifest.seed ?? []) {
    if (!('sql' in step)) continue;
    const { file } = sqlSource(step.sql);
    if (file) files.add(resolve(sandbox.dir, file));
  }
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) files.add(abs);
    }
  };
  await walk(join(sandbox.dir, SANDBOX_SEED_DIR));
  return [...files].sort();
}

/**
 * The hash of what a sandbox's seed builds (sha256, hex): its seed steps, reset strategy and snapshot settings, its
 * databases, the bytes of the files it reads (seedFileRefs), and `extra` (what the caller knows changes the data: the
 * compose services' image ids…). A snapshot taken with another hash is stale.
 */
export async function seedHash(sandbox: Pick<LoadedSandbox, 'dir' | 'manifest'>, extra: readonly string[] = []): Promise<string> {
  const m = sandbox.manifest;
  const h = createHash('sha256');
  h.update(canonicalJson({ seed: m.seed ?? [], strategy: m.reset?.strategy ?? 'reseed', snapshot: m.reset?.snapshot ?? null, databases: m.databases ?? {} }));
  for (const file of await seedFileRefs(sandbox)) {
    h.update(`\0${relative(sandbox.dir, file)}\0`);
    try {
      h.update(await readFile(file));
    } catch {
      h.update('\0missing\0');
    }
  }
  for (const e of extra) h.update(`\0extra\0${e}`);
  return h.digest('hex');
}

/**
 * The env file of a docker-compose sandbox (L5.8, R-FLD-32), absolute: `compose.env_file` (relative to sandbox.yaml),
 * else `.env` next to the first compose file when it exists; undefined for none (`env_file: false`, no such file, a
 * process sandbox). Retake passes it to every compose command (`--env-file`), and leaves the names it sets out of
 * the environment docker runs with — a shell's value would win over the file's.
 */
export function composeEnvFile(sandbox: Pick<LoadedSandbox, 'dir' | 'manifest'>): string | undefined {
  return composeEnvFilePath(sandbox.dir, sandbox.manifest, existsSync);
}
