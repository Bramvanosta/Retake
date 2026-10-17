/**
 * Sandbox mode (L1.8), the core model: a project.yaml `sandboxes:` entry names a sandbox.yaml (version 1) — how to start
 * a disposable, local copy of the product, seed it and reset it before a take. loadProject reads each manifest and adds
 * the sandbox as an environment of its own: its pages and display URLs (`environments`, `environment_settings`), its
 * accounts as the personas of that environment (`auth`, login steps with {{account.username}} / {{account.password}}
 * substituted), its mailbox and databases (mailboxFor / databasesFor). A sandbox is never production and always
 * read-write; its URLs are loopback only. Starting, seeding and resetting it is @demo-studio/sandbox's job.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, isScalar, parseDocument } from 'yaml';
import { checkSandbox } from './checks/sandbox.js';
import { normalizeDisplay } from './display.js';
import { isGlobalAuth } from './auth.js';
import { ConfigError, hasErrors, issuesMessage } from './issues.js';
import { sqlSource } from './destructive.js';
import { SandboxFileSchema } from './schemas/sandbox.js';
import { SANDBOX_VERSION } from './types.js';
import type {
  AuthConfig,
  DatabaseConfig,
  EnvironmentSandbox,
  EnvironmentSettings,
  LoadedProject,
  LoadedSandbox,
  MailboxConfig,
  PersonaConfig,
  ProjectConfig,
  SandboxManifest,
  ValidationIssue,
} from './types.js';
import { checkYamlDocument } from './validation/document.js';

/** The usual file name of a sandbox manifest. */
export const SANDBOX_FILE = 'sandbox.yaml';
/** The folder next to sandbox.yaml whose files count in the seed hash (SQL files, scripts). */
export const SANDBOX_SEED_DIR = 'seed';
/** The JSON Schema of sandbox.yaml (`# yaml-language-server: $schema=…` in the files `studio sandbox init` writes). */
export const SANDBOX_SCHEMA_FILE = fileURLToPath(new URL('../schema/sandbox.schema.json', import.meta.url));

/** A sandbox.yaml with errors: positioned in the manifest (`file`), for the sandbox environment `env`. */
export class SandboxConfigError extends ConfigError {
  constructor(
    message: string,
    issues: ValidationIssue[],
    file: string,
    /** The sandbox's environment name. */
    readonly env: string,
  ) {
    super(message, issues, file);
    this.name = 'ConfigError';
  }
}

export interface ParseSandboxOptions {
  /** The environment name it becomes (messages). */
  env?: string;
  /** The project it belongs to (normalised project.yaml, sandboxes not merged yet): see checkSandbox. */
  project?: Pick<LoadedProject, 'config'>;
}

/**
 * Validate sandbox.yaml text. `file` (its path) enables the checks of the files it names, relative to its folder.
 * A version above 1 is refused before anything else (made for a newer Demo Studio). `manifest` is returned only when
 * there is no error-level issue.
 */
export function parseSandboxYaml(text: string, file?: string, opts: ParseSandboxOptions = {}): { manifest?: SandboxManifest; issues: ValidationIssue[] } {
  const dir = file ? dirname(resolve(file)) : undefined;
  const { value, issues } = checkYamlDocument(
    text,
    SandboxFileSchema,
    (val, structural) => checkSandbox(val, structural, { dir, env: opts.env, project: opts.project }),
    {},
    { formatVersion: { file: SANDBOX_FILE, supported: SANDBOX_VERSION } },
  );
  if (hasErrors(issues)) return { issues };
  return { manifest: value as SandboxManifest, issues };
}

const SECRET_REF = /^\{\{\s*(env|keychain|secret):[^{}]+?\s*\}\}$/;

/** A login-step value with {{account.username}} / {{account.password}} replaced (recursively). */
function substituteAccount(v: unknown, account: { username?: string; password?: string }): unknown {
  if (typeof v === 'string') {
    return v.replace(/\{\{\s*account\.(username|password)\s*\}\}/g, (m, field: 'username' | 'password') => account[field] ?? m);
  }
  if (Array.isArray(v)) return v.map((x) => substituteAccount(x, account));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substituteAccount(x, account)]));
  return v;
}

/**
 * The accounts of a sandbox as the auth block of its environment (login steps with their {{account.*}} substituted),
 * and the plain passwords by persona (secret values: masked wherever a run writes).
 */
export function sandboxAuth(manifest: SandboxManifest): { auth?: AuthConfig; secrets: Record<string, string[]> } {
  const secrets: Record<string, string[]> = {};
  if (!manifest.accounts && manifest.login_url === undefined) return { secrets };
  const personas: Record<string, PersonaConfig> = {};
  for (const [name, account] of Object.entries(manifest.accounts ?? {})) {
    const { username, password, ...persona } = account;
    if (persona.login) persona.login = substituteAccount(persona.login, { username, password }) as PersonaConfig['login'];
    personas[name] = persona;
    if (password !== undefined && !SECRET_REF.test(password.trim())) secrets[name] = [password];
  }
  return {
    auth: { ...(manifest.login_url !== undefined ? { login_url: manifest.login_url } : {}), ...(manifest.accounts ? { personas } : {}) },
    secrets,
  };
}

/** A sandbox's pages: real URLs and display bases (normalised), in the order its services declare them. */
export function sandboxPages(manifest: SandboxManifest): { pages: Record<string, string>; display: Record<string, string> } {
  const pages: Record<string, string> = {};
  const display: Record<string, string> = {};
  for (const svc of Object.values(manifest.services)) {
    for (const [key, v] of Object.entries(svc.pages ?? {})) {
      pages[key] = typeof v === 'string' ? v : v.url;
      if (typeof v === 'object' && v.display !== undefined) display[key] = normalizeDisplay(v.display);
    }
  }
  return { pages, display };
}

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
    const { manifest, issues } = parseSandboxYaml(text, file, { env, project: { config } });
    if (!manifest) throw new SandboxConfigError(issuesMessage(`sandbox ${env}`, issues, file), issues, file, env);
    out[env] = { env, file, dir: dirname(file), manifest, issues, secrets: sandboxAuth(manifest).secrets };
  }
  return out;
}

/**
 * project.yaml (normalised) + its sandboxes → the configuration every consumer uses: each sandbox is an environment
 * (pages, display URLs, `environment_settings[env].sandbox|mailbox|databases`) and its accounts are that environment's
 * personas. A global `auth` becomes keyed by every other environment (the same block for each: nothing changes for
 * them); projects without sandboxes are never passed here.
 */
export function mergeSandboxes(config: ProjectConfig, sandboxes: Record<string, LoadedSandbox>): ProjectConfig {
  const environments = { ...config.environments };
  const settings: Record<string, EnvironmentSettings> = { ...(config.environment_settings ?? {}) };
  let auth: Record<string, AuthConfig> | undefined;
  if (config.auth !== undefined) {
    auth = isGlobalAuth(config.auth)
      ? Object.fromEntries(Object.keys(config.environments).map((env) => [env, config.auth as AuthConfig]))
      : { ...(config.auth as Record<string, AuthConfig>) };
  }
  for (const s of Object.values(sandboxes)) {
    const { pages, display } = sandboxPages(s.manifest);
    environments[s.env] = pages;
    const { clear: _clear, external: _external, ...mailbox } = s.manifest.mailbox ?? ({} as Partial<NonNullable<SandboxManifest['mailbox']>>);
    settings[s.env] = {
      ...(Object.keys(display).length ? { display } : {}),
      sandbox: { file: s.file, provider: s.manifest.provider },
      ...(s.manifest.mailbox ? { mailbox: mailbox as MailboxConfig } : {}),
      ...(s.manifest.databases ? { databases: Object.fromEntries(Object.entries(s.manifest.databases).map(([k, d]) => [k, { url: d.url }])) } : {}),
    };
    const { auth: block } = sandboxAuth(s.manifest);
    if (block) (auth ??= {})[s.env] = block;
  }
  return { ...config, environments, environment_settings: settings, ...(auth ? { auth } : {}) };
}

/** The sandbox an environment is (its manifest and provider), or undefined. */
export function sandboxOf(project: Pick<LoadedProject, 'config'>, env: string | undefined): EnvironmentSandbox | undefined {
  if (env === undefined) return undefined;
  const settings = project.config.environment_settings;
  return settings && Object.hasOwn(settings, env) ? settings[env].sandbox : undefined;
}

/** The sandbox environments of a project, in the order project.yaml declares them. */
export function sandboxNames(project: Pick<LoadedProject, 'config'>): string[] {
  return Object.keys(project.config.sandboxes ?? {});
}

/**
 * The test mailbox `wait_for_email` reads on an environment: a sandbox's own (none when its sandbox.yaml declares
 * none: it never reads the project's), else the project's `mailbox`.
 */
export function mailboxFor(project: Pick<LoadedProject, 'config'>, env: string | undefined): MailboxConfig | undefined {
  const sandbox = sandboxOf(project, env);
  return sandbox ? project.config.environment_settings?.[env!]?.mailbox : project.config.mailbox;
}

/**
 * The databases sql hooks reach on an environment: a sandbox's own only (a hook on a sandbox never reaches a database
 * of project.yaml), else the project's `databases`. Journal replays ask for the environment each entry ran in.
 */
export function databasesFor(project: Pick<LoadedProject, 'config'>, env: string | undefined): Record<string, DatabaseConfig> {
  const sandbox = sandboxOf(project, env);
  return (sandbox ? project.config.environment_settings?.[env!]?.databases : project.config.databases) ?? {};
}

/** Where a project's databases are declared, for messages: "sandbox.yaml of sandbox X" or "project.yaml". */
export function databasesSource(project: Pick<LoadedProject, 'config'>, env: string | undefined): string {
  return sandboxOf(project, env) ? `the sandbox.yaml of sandbox ${env}` : 'project.yaml';
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

/** JSON with sorted keys (a hash input that does not depend on the order keys are written in). */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
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
 * project.yaml text with `sandboxes.<env>: <file>` added, the rest of the text untouched (its line endings kept):
 * appended at the end when there is no `sandboxes:` yet (before a `...` document end), written after the last entry of
 * a block `sandboxes:` mapping, or inside a one-line flow mapping (`sandboxes: {}`, `sandboxes: {a: a/sandbox.yaml}`).
 * Any other layout goes through the yaml Document API (comments kept, no line folding). Unchanged when that entry is
 * already there; throws when `env` names another manifest, or the text is not a YAML mapping.
 */
export function addSandboxEntry(text: string, env: string, file: string): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`project.yaml cannot be read: ${doc.errors[0].message}`);
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error('project.yaml is not a mapping');
  const current = doc.get('sandboxes', true);
  const empty = current === undefined || current === null || (isScalar(current) && current.value === null);
  if (!empty && !isMap(current)) throw new Error('project.yaml `sandboxes` is not a mapping (environment name → sandbox.yaml)');
  if (!empty && isMap(current)) {
    const was = current.get(env);
    if (was !== undefined) {
      if (was === file) return text;
      throw new Error(`project.yaml already declares sandbox ${env} (${String(was)})`);
    }
  }
  const expected = parseDocument(text).toJS() ?? {};
  expected.sandboxes = { ...(empty ? {} : (expected.sandboxes as Record<string, unknown>)), [env]: file };
  const ok = (out: string) => {
    const d = parseDocument(out);
    return !d.errors.length && JSON.stringify(d.toJS()) === JSON.stringify(expected);
  };
  const entry = `${env}: ${file}`;
  // The text's own line ending (a CRLF file stays CRLF).
  const cr = text.includes('\r\n') ? '\r' : '';
  const lines = text.split('\n');
  let out: string | null = null;
  if (current === undefined) {
    // At the end, before a `...` document end marker.
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    if (end > 0 && /^\.\.\.\s*(#.*)?$/.test(lines[end - 1])) end--;
    while (end > 0 && !lines[end - 1].trim()) end--;
    const tail = lines.slice(end).join('\n');
    out = [...lines.slice(0, end), `sandboxes:${cr}`, `  ${entry}${cr}`].join('\n') + (tail.trim() ? `\n${tail.replace(/^\n+/, '')}` : `\n`);
  } else {
    const at = lines.findIndex((l) => /^sandboxes:/.test(l));
    const flow = at >= 0 ? /^(sandboxes:\s*\{)(.*?)(\}\s*(#.*)?\r?)$/.exec(lines[at]) : null;
    if (flow) {
      // A one-line flow mapping: the entry before its closing brace.
      const inner = flow[2].trim();
      lines[at] = `${flow[1]}${inner ? `${flow[2].replace(/\s*$/, '')}, ${entry}` : entry}${flow[3]}`;
      out = lines.join('\n');
    } else if (at >= 0 && /^sandboxes:\s*(#.*)?\r?$/.test(lines[at])) {
      // A block mapping: after its last indented line.
      let end = at;
      let indent = '  ';
      for (let i = at + 1; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim() || /^\s*#/.test(l)) continue;
        const m = /^(\s+)\S/.exec(l);
        if (!m) break;
        if (end === at) indent = m[1];
        end = i;
      }
      out = [...lines.slice(0, end + 1), `${indent}${entry}${cr}`, ...lines.slice(end + 1)].join('\n');
    }
  }
  if (out !== null && ok(out)) return out;
  // Any other layout (a flow mapping over several lines…): the Document API, without folding long lines.
  const sb = doc.get('sandboxes', true);
  if (isMap(sb)) sb.set(env, file);
  else doc.set('sandboxes', doc.createNode({ [env]: file }));
  const written = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  if (!ok(written)) throw new Error('project.yaml could not be updated');
  return written;
}
