/**
 * A project's docker-compose sandboxes read against the compose subset an archive hands over (core compose-subset.ts),
 * by Retake itself — no docker, so it runs on an imported project before anyone trusts it: what an export refuses, what
 * an import of a crafted archive refuses, what the trust listing shows, what the override covers and what a trusted
 * import's sandbox may start with (guard.ts). It fails closed: anything outside the subset is a problem, and a sandbox
 * with a problem is not handed over.
 *
 * Per sandbox: sandbox.yaml inside the project; its compose files (default compose.yaml) all in one folder — the folder
 * every relative path resolves from, the one Retake gives docker compose as `--project-directory` (`folderAs`: where
 * that folder will be once imported, for an export whose compose files are copied); each file within the subset; each
 * `env_file` a relative path resolving inside the project from that folder; each bind source inside the sandbox's data
 * folder (`<folder of sandbox.yaml>/data/`: never the project's code, layout or state — hooks, components, themes,
 * sandbox.yaml, `.retake/`); sandbox.yaml's own
 * `compose.env_file` inside the project (an import). On an import (`carried`: the services the archive carries an image
 * for), a service that is built and has no carried image is a problem: the override that replaces builds needs one.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseYaml, pathInside, showHiddenCharsLine } from '@retake/core/base';
import { readComposeSubset } from '@retake/core/sandbox';
import type { SubsetService } from '@retake/core/sandbox';

/** The folder next to sandbox.yaml that a handed-over sandbox's binds may mount (read-write): its data, nothing else. */
export const SANDBOX_DATA_DIR = 'data';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const posix = (p: string): string => p.split(sep).join('/');
const shown = showHiddenCharsLine;

/** One service as accepted: what the subset read, with where its env files and binds resolve (project paths). */
export interface SubsetServiceAt extends SubsetService {
  /** Its env files, as project paths where they resolve (`folderAs`). */
  env_at: string[];
  /** Its env files, as project paths where they resolve on this disk now (what an export leaves out). */
  env_here: string[];
  binds_at: Array<{ at: string; target: string }>;
}

/** One docker-compose sandbox read against the subset. */
export interface SandboxSubset {
  env: string;
  /** The compose files read (project paths, or the path as named). */
  files: string[];
  services: SubsetServiceAt[];
  /** Everything outside the subset, each with where it is: the sandbox is not handed over while there is one. */
  problems: string[];
}

export interface SubsetOptions {
  mode: 'export' | 'import';
  /** Where the compose files' folder will be once imported (an export that copies them), absolute. */
  folderAs?: (env: string) => string | undefined;
  /** On an import: whether the archive carries an image for a service. */
  carried?: (env: string, service: string) => boolean;
}

const at = (projectDir: string, abs: string): string => (pathInside(abs, projectDir) ? posix(relative(projectDir, abs)) || '.' : posix(abs));

/** One sandbox (sandbox.yaml at `sbFile`) read against the subset (the module's header). */
export async function readSandboxSubset(projectDir: string, env: string, sbFile: string, o: SubsetOptions): Promise<SandboxSubset | undefined> {
  const read: SandboxSubset = { env, files: [], services: [], problems: [] };
  const where = (why: string) => read.problems.push(why);
  if (!pathInside(sbFile, projectDir)) {
    where(`${at(projectDir, sbFile)}: its sandbox.yaml lies outside the project`);
    return read;
  }
  const sb = parseYaml(await readFile(sbFile, 'utf8').catch(() => '')).value;
  if (!isObj(sb) || sb.provider !== 'docker-compose') return undefined;
  const compose = isObj(sb.compose) ? sb.compose : {};
  const names = Array.isArray(compose.files) ? compose.files.filter((f): f is string => typeof f === 'string') : ['compose.yaml'];
  const files = names.map((f) => resolve(dirname(sbFile), f));
  const folder = dirname(files[0] ?? sbFile);
  for (const f of files)
    if (dirname(f) !== folder) where(`${at(projectDir, f)}: a compose file in another folder than the first (${at(projectDir, folder)}): its relative paths would resolve from there`);
  if (o.mode === 'import') {
    for (const f of files) if (!pathInside(f, projectDir)) where(`${at(projectDir, f)}: a compose file outside the project`);
    if (typeof compose.env_file === 'string' && !pathInside(resolve(dirname(sbFile), compose.env_file), projectDir)) where(`sandbox.yaml compose.env_file (${compose.env_file}): outside the project`);
  }
  const folderAs = o.folderAs?.(env) ?? folder;
  /** Where binds may point: the data folder next to sandbox.yaml (SANDBOX_DATA_DIR). */
  const dataDir = join(dirname(sbFile), SANDBOX_DATA_DIR);
  const byName = new Map<string, SubsetServiceAt>();
  for (const f of files) {
    const text = await readFile(f, 'utf8').catch(() => undefined);
    const label = at(projectDir, f);
    if (text === undefined) {
      where(`${label}: missing`);
      continue;
    }
    read.files.push(label);
    const r = readComposeSubset(text, label);
    read.problems.push(...r.problems);
    for (const s of r.services) {
      const env_at: string[] = [];
      const env_here: string[] = [];
      for (const e of s.env_files) {
        const there = resolve(folderAs, e);
        if (!pathInside(there, projectDir)) where(`${label}: services.${s.name}.env_file ${e}: resolves outside the project (${at(projectDir, there)})`);
        else env_at.push(at(projectDir, there));
        const here = resolve(folder, e);
        if (pathInside(here, projectDir)) env_here.push(at(projectDir, here));
      }
      const binds_at: SubsetServiceAt['binds_at'] = [];
      for (const b of s.binds) {
        const there = resolve(folderAs, b.source);
        // Only the sandbox's own data folder (<sandbox>/data and below): never the project's code, layout or state.
        if (!pathInside(there, dataDir))
          where(`${label}: services.${s.name}.volumes ${b.source}: a bind that resolves outside the sandbox's data folder ${at(projectDir, dataDir)} (to ${at(projectDir, there)})`);
        else binds_at.push({ at: at(projectDir, there), target: b.target });
      }
      const was = byName.get(s.name);
      const merged: SubsetServiceAt = was
        ? {
            ...was,
            ...(s.image !== undefined ? { image: s.image } : {}),
            ...(s.build !== undefined ? { build: s.build } : {}),
            ...(s.pull_policy !== undefined ? { pull_policy: s.pull_policy } : {}),
            env_files: [...was.env_files, ...s.env_files],
            binds: [...was.binds, ...s.binds],
            volumes: [...was.volumes, ...s.volumes],
            ports: [...was.ports, ...s.ports],
            keys: [...new Set([...was.keys, ...s.keys])],
            env_at: [...was.env_at, ...env_at],
            env_here: [...was.env_here, ...env_here],
            binds_at: [...was.binds_at, ...binds_at],
          }
        : { ...s, env_at, env_here, binds_at };
      byName.set(s.name, merged);
    }
  }
  read.services = [...byName.values()];
  if (o.mode === 'import')
    for (const s of read.services)
      if (s.build !== undefined && !o.carried?.(env, s.name)) where(`services.${s.name}: it is built and the archive carries no image for it (the override that replaces builds needs one)`);
  return read;
}

/** Every docker-compose sandbox of the project at `projectDir` (project.yaml `sandboxes:`) read against the subset. */
export async function readProjectSubsets(projectDir: string, o: SubsetOptions): Promise<SandboxSubset[]> {
  const project = parseYaml(await readFile(join(projectDir, 'project.yaml'), 'utf8').catch(() => '')).value;
  const out: SandboxSubset[] = [];
  for (const [env, rel] of Object.entries(isObj(project) && isObj(project.sandboxes) ? project.sandboxes : {})) {
    if (typeof rel !== 'string') continue;
    const r = await readSandboxSubset(projectDir, env, resolve(projectDir, rel), o);
    if (r) out.push(r);
  }
  return out;
}

/** The lines a person reads of what each sandbox runs, as accepted, and what is not handed over (shown with hidden characters written out). */
export function subsetLines(reads: readonly SandboxSubset[], carried: (env: string, service: string) => string | undefined = () => undefined): string[] {
  const lines: string[] = [];
  for (const r of reads) {
    const env = shown(r.env);
    for (const s of r.services) {
      const c = carried(r.env, s.name);
      const what = [
        s.image ? `image ${shown(s.image)}` : undefined,
        s.build !== undefined ? `built from ${shown(s.build)}` : undefined,
        c ? `runs the carried image ${c}` : undefined,
        s.ports.length ? `ports ${s.ports.map(shown).join(', ')}` : undefined,
      ];
      lines.push(`sandbox ${env}: service ${shown(s.name)} — ${what.filter(Boolean).join(', ') || 'no image'}`);
      for (const b of s.binds_at) lines.push(`sandbox ${env}: service ${shown(s.name)} mounts ${shown(b.at)} at ${shown(b.target)} (the sandbox's data folder: provide it there)`);
      for (const e of s.env_at) lines.push(`sandbox ${env}: service ${shown(s.name)} reads the env file ${shown(e)} (never carried: provide it there)`);
      if (s.volumes.length) lines.push(`sandbox ${env}: service ${shown(s.name)} uses the named volumes ${s.volumes.map(shown).join(', ')}`);
      if (s.keys.length) lines.push(`sandbox ${env}: service ${shown(s.name)} also sets ${s.keys.map(shown).join(', ')}`);
    }
    for (const p of r.problems) lines.push(`sandbox ${env}: NOT HANDED OVER — ${shown(p)}`);
  }
  return lines;
}

/** The problems of the subsets, as one refusal's words (the first few, and how many more). */
export function subsetProblems(reads: readonly SandboxSubset[]): string | undefined {
  const all = reads.flatMap((r) => r.problems.map((p) => `sandbox ${shown(r.env)}: ${shown(p)}`));
  if (!all.length) return undefined;
  return `${all.slice(0, 12).join('; ')}${all.length > 12 ? `; and ${all.length - 12} more` : ''}`;
}

/** Why the services an archive puts its images on do not hold against the compose files (a service they lack, another image name), or undefined. */
export function usesProblem(uses: ReadonlyArray<{ env: string; service: string; name: string }>, reads: readonly SandboxSubset[]): string | undefined {
  for (const u of uses) {
    const svc = reads.find((r) => r.env === u.env)?.services.find((s) => s.name === u.service);
    if (!svc) return `it puts an image on service ${shown(u.service)} of sandbox ${shown(u.env)}, which its compose files do not have`;
    if (svc.image && svc.image !== u.name)
      return `it puts an image on service ${shown(u.service)} of sandbox ${shown(u.env)}, whose compose file names another image (${shown(svc.image)}, not ${shown(u.name)})`;
  }
  return undefined;
}
