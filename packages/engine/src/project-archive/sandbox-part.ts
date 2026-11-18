/**
 * `retake project export --with-sandbox` (a person's option at a terminal): what a project archive carries of the
 * project's sandboxes beyond the files plan.ts walks.
 *
 * - sandbox.yaml must lie inside the project (refused otherwise: move it in). The compose files it names that lie
 *   outside the project (the product's repository) are copied next to it, under `compose-files/`, and the archive's
 *   copy of sandbox.yaml names them there (`compose.files` rewritten; comments kept). Their relative paths then
 *   resolve there: a build context is never copied (its image is saved instead, below), a bind mount never (listed:
 *   `host_mounts`), a service's env file never (listed by key names).
 * - The env file the sandbox's compose commands read (`--env-file`) is never in an archive unless the person asked for
 *   it (`with_env`, never through MCP); its key names always are. One outside the project goes to `compose-files/` too,
 *   carried or not: sandbox.yaml's `compose.env_file` names it there when it named it; the default (a `.env` next to
 *   the first compose file) finds it next to that file's copy.
 * - The files of compose `secrets` and `configs` are never carried (plan.ts leaves those inside the project out), nor
 *   what an `include:` or `extends.file` names, a seed file outside the project, a process service's `cwd` outside
 *   it: each listed in `outside`, for the person who imports it to provide.
 * - The images (unless `images: false`): every service's image as docker holds it here — a built one by the name its
 *   build gives it — inspected for its id, platform and size; one this machine does not hold is refused with the fix
 *   (up the sandbox with --build; pull it; or export with --no-images). export.ts saves each by id.
 *
 * docker is reached through the Sandboxes port's `share` only (docker compose config, image inspect): the engine runs
 * no docker itself. A process sandbox needs no docker.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { errorMessage, pathInside, showHiddenCharsLine } from '@retake/core/base';
import { realpathOr, seedFileRefs } from '@retake/core/io';
import { readFileSync } from 'node:fs';
import { envFileKeys } from '@retake/core/sandbox';
import { readSandboxSubset } from './compose-read.js';
import { DEFAULT_COMPOSE_FILES, rewriteSandboxCompose } from '@retake/core/sandbox';
import type { LoadedSandbox } from '@retake/core/sandbox';
import type { LoadedProject } from '@retake/core/project';
import type { WorkPolicy } from '@retake/core/policy';
import type { DockerFacts, SandboxShare, ShareFacts } from '@retake/sandbox/types';
import { EngineError } from '../errors.js';
import type { SandboxPart } from './manifest.js';

/** The folder next to sandbox.yaml where an archive puts the compose files (and env file) that lay outside the project. */
export const SHARED_COMPOSE_DIR = 'compose-files';

/** A file the sandbox part adds to the archive (a copy from outside the project, or the env file a person asked for). */
export interface SandboxFile {
  path: string;
  from: string;
  origin: 'sandbox' | 'env';
}

/** An image to save: its id, platform, size and the names it runs under. */
export interface PlannedImage {
  id: string;
  platform: string;
  size: number;
  names: string[];
  uses: Array<{ env: string; service: string }>;
}

export interface SandboxPlan {
  parts: SandboxPart[];
  /** Each sandbox's compose folder as it will be once imported (for the listing of what it runs). */
  folders: Map<string, string>;
  /** The same, as compose-read's option. */
  folderAs: (env: string) => string | undefined;
  /**
   * Project paths never carried, as docker compose resolved them (every env file, secret and config file the compose
   * files reach — through `include:`, `extends` or `${…}` too — and the sandbox's env file unless a person carries it).
   */
  exclude: Set<string>;
  /** Files to add (project paths). */
  add: SandboxFile[];
  /** Files whose archive copy differs (sandbox.yaml rewritten): project path → bytes. */
  replace: Map<string, Buffer>;
  images: PlannedImage[];
  docker?: DockerFacts;
}

export interface SandboxPlanOptions {
  images: boolean;
  withEnv: boolean;
  share: SandboxShare | undefined;
  policy: WorkPolicy;
  /** Project paths the walk already takes (a copy never lands on one). */
  taken: ReadonlySet<string>;
}

const posix = (p: string): string => p.split(sep).join('/');

/** A path of the exporter's machine as the manifest says it: relative to the project inside the workspace, `~/…` under home, else as it is. */
export function shownRef(project: Pick<LoadedProject, 'dir' | 'root'>, abs: string): string {
  if (pathInside(abs, project.root)) return posix(relative(project.dir, abs)) || '.';
  const home = homedir();
  if (pathInside(abs, home)) return `~/${posix(relative(home, abs))}`;
  return posix(abs);
}

/**
 * A path docker gave (compose resolves real paths: /private/var… for /var… on a Mac) in the project's own spelling,
 * so that it compares with the project's folder: the real path of the workspace root (or of home) replaced by its own.
 */
function spelledAs(project: Pick<LoadedProject, 'root'>): (abs: string) => string {
  const pairs = [project.root, homedir()].map((own) => [realpathOr(own, own), own] as const).filter(([real, own]) => real !== own);
  return (abs) => {
    for (const [real, own] of pairs) if (abs === real || abs.startsWith(`${real}${sep}`)) return own + abs.slice(real.length);
    return abs;
  };
}

/** The compose facts with every path in the project's own spelling (spelledAs). */
function respelled(project: Pick<LoadedProject, 'root'>, f: ShareFacts): ShareFacts {
  const p = spelledAs(project);
  return {
    ...f,
    files: f.files.map(p),
    ...(f.envFile ? { envFile: p(f.envFile) } : {}),
    services: f.services.map((s) => ({
      ...s,
      ...(s.build ? { build: p(s.build) } : {}),
      binds: s.binds.map((b) => ({ ...b, source: p(b.source) })),
      envFiles: s.envFiles.map(p),
      envFileKeys: s.envFileKeys.map((e) => ({ ...e, file: p(e.file) })),
    })),
    secretFiles: f.secretFiles.map(p),
    configFiles: f.configFiles.map(p),
  };
}

/** The key names of an env file (none when it is not there). */
function keysOf(file: string): string[] {
  try {
    return envFileKeys(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

const platformOf = (i: { os: string; arch: string; variant?: string }): string => `${i.os}/${i.arch}${i.variant ? `/${i.variant}` : ''}`;

/** A free project path in `dir` for `name` (`compose.yaml`, then `compose-2.yaml`…). */
function freePath(dir: string, name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const p = `${dir}/${n === 1 ? name : `${stem}-${n}${ext}`}`;
    if (!taken.has(p)) {
      taken.add(p);
      return p;
    }
  }
}

/** The outside refs every provider shares: seed files outside the project, a process service's folder outside it. */
async function outsideRefs(project: LoadedProject, sb: LoadedSandbox): Promise<SandboxPart['outside']> {
  const out: SandboxPart['outside'] = [];
  for (const f of await seedFileRefs(sb)) if (!pathInside(f, project.dir)) out.push({ ref: shownRef(project, f), what: 'a seed file outside the project (not carried: provide it there)' });
  for (const [svc, s] of Object.entries(sb.manifest.services ?? {})) {
    const cwd = (s as { cwd?: unknown }).cwd;
    if (typeof cwd === 'string' && !pathInside(resolve(sb.dir, cwd), project.dir))
      out.push({ ref: shownRef(project, resolve(sb.dir, cwd)), what: `the folder service ${svc} starts in (cwd: the product's code, never carried — provide it there)` });
  }
  return out;
}

/** The compose facts of a sandbox through the port, a refusal in words otherwise. */
async function composeFacts(project: LoadedProject, sb: LoadedSandbox, o: SandboxPlanOptions): Promise<ShareFacts> {
  if (!o.share) throw new EngineError('refused', `sandbox ${sb.env}: this Retake's sandboxes hand over no compose files or images (no share in its Sandboxes port)`);
  try {
    return respelled(project, await o.share.compose(project, sb.env, o.policy));
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError('refused', `sandbox ${sb.env}: docker is needed to read its compose files and save its images (${errorMessage(e)}) — start Docker, then export again`);
  }
}

/** One docker-compose sandbox's part: copies, rewrite, env file, mounts, outside refs, the images to save. */
async function composePart(project: LoadedProject, sb: LoadedSandbox, o: SandboxPlanOptions, plan: SandboxPlan, taken: Set<string>): Promise<SandboxPart> {
  const facts = await composeFacts(project, sb, o);
  const sbRel = posix(relative(project.dir, sb.dir));
  const at = (p: string) => (sbRel ? `${sbRel}/${p}` : p);
  const part: SandboxPart = { env: sb.env, provider: 'docker-compose', copied: [], rewritten: [], outside: await outsideRefs(project, sb), host_mounts: [], service_env_files: [], images: [] };
  // The compose files sandbox.yaml names (never the trust override, which is this machine's state).
  const declared = sb.manifest.compose?.files ?? DEFAULT_COMPOSE_FILES;
  let changed = false;
  const files = declared.map((f) => {
    const abs = resolve(sb.dir, f);
    if (pathInside(abs, project.dir)) return f;
    const to = freePath(at(SHARED_COMPOSE_DIR), basename(abs), taken);
    plan.add.push({ path: to, from: abs, origin: 'sandbox' });
    part.copied.push({ from: shownRef(project, abs), to });
    changed = true;
    return posix(relative(sb.dir, resolve(project.dir, to)));
  });
  let envFile: string | undefined;
  if (facts.envFile) {
    const inside = pathInside(facts.envFile, project.dir);
    // Named by sandbox.yaml: named again where the copy goes. The default (.env next to the first compose file): it
    // goes next to that file's copy, where the default finds it again — sandbox.yaml unchanged for it.
    const named = typeof sb.manifest.compose?.env_file === 'string';
    const firstCopy = plan.add.find((a) => a.origin === 'sandbox' && a.from === resolve(sb.dir, declared[0] ?? ''));
    const path = inside
      ? posix(relative(project.dir, facts.envFile))
      : named || !firstCopy
        ? freePath(at(SHARED_COMPOSE_DIR), basename(facts.envFile), taken)
        : `${posix(dirname(firstCopy.path))}/.env`;
    if (!inside && named) {
      envFile = posix(relative(sb.dir, resolve(project.dir, path)));
      changed = true;
    }
    part.env_file = { path, from: shownRef(project, facts.envFile), keys: [...facts.envKeys], included: o.withEnv };
    if (o.withEnv) plan.add.push({ path, from: facts.envFile, origin: 'env' });
    else if (inside) plan.exclude.add(path);
  }
  // The compose files read against the subset (compose-read.ts), their relative paths from the folder they will be in
  // once imported (the copies' folder when the first file is copied): anything outside it, and the sandbox is not
  // handed over.
  const firstAbs = resolve(sb.dir, declared[0] ?? 'compose.yaml');
  const firstTo = plan.add.find((a) => a.origin === 'sandbox' && a.from === firstAbs)?.path;
  const folder = dirname(firstAbs);
  const folderAs = firstTo ? resolve(project.dir, dirname(firstTo)) : folder;
  plan.folders.set(sb.env, folderAs);
  const read = await readSandboxSubset(project.dir, sb.env, sb.file, { mode: 'export', folderAs: () => folderAs });
  const problems = [...(read?.problems ?? [])];
  if (!o.images)
    for (const sv of read?.services ?? [])
      if (sv.build !== undefined) problems.push(`services.${sv.name}: it is built, and --no-images carries no image for it (an import refuses a built service without one)`);
  if (problems.length)
    throw new EngineError(
      'refused',
      `sandbox ${sb.env}: its compose files are outside the compose subset an archive hands over — ${problems.slice(0, 12).map(showHiddenCharsLine).join('; ')}${problems.length > 12 ? `; and ${problems.length - 12} more` : ''} (the sandbox guide, "Handing a sandbox over", lists the subset)`,
    );
  if (changed) {
    const text = await readFile(sb.file, 'utf8');
    const rel = posix(relative(project.dir, sb.file));
    plan.replace.set(rel, Buffer.from(rewriteSandboxCompose(text, { files, ...(envFile !== undefined ? { envFile } : {}) })));
    part.rewritten.push(rel);
  }
  for (const sv of read?.services ?? []) {
    sv.binds.forEach((b, i) => part.host_mounts.push({ service: sv.name, source: shownRef(project, resolve(folder, b.source)), target: b.target, expected_at: sv.binds_at[i]?.at ?? b.source }));
    sv.env_files.forEach((e, i) => {
      const here = resolve(folder, e);
      part.service_env_files.push({ service: sv.name, path: shownRef(project, here), keys: keysOf(here), expected_at: sv.env_at[i] ?? e });
    });
    for (const h of sv.env_here) plan.exclude.add(h);
    if (sv.build !== undefined) part.outside.push({ ref: shownRef(project, resolve(folder, sv.build)), what: `the build context of service ${sv.name} (never carried: its image is)` });
  }
  if (o.images) await imagesOf({ project, sb, facts, o, plan, part });
  return part;
}

/** The images of a sandbox's services, inspected; one this machine does not hold refused with the fix. */
async function imagesOf(at: { project: LoadedProject; sb: LoadedSandbox; facts: ShareFacts; o: SandboxPlanOptions; plan: SandboxPlan; part: SandboxPart }): Promise<void> {
  const { project, sb, facts, o, plan, part } = at;
  const share = o.share as SandboxShare;
  const names = [...new Set(facts.services.map((s) => s.image))];
  const found = await share.inspect(names, o.policy);
  for (const s of facts.services) {
    const i = found[s.image];
    if (!i) {
      const fix = s.build ? `retake sandbox up ${project.slug} --env ${sb.env} --build` : `docker pull ${s.image}`;
      throw new EngineError(
        'refused',
        `sandbox ${sb.env}: the image of service ${showHiddenCharsLine(s.name)} (${showHiddenCharsLine(s.image)}) is not on this machine${s.build ? ` — it is built from ${showHiddenCharsLine(shownRef(project, s.build))}, which an archive never carries` : ''}: ${fix} first, or export with --no-images`,
        { fix },
      );
    }
    part.images.push({ service: s.name, name: s.image, id: i.id });
    let p = plan.images.find((x) => x.id === i.id);
    if (!p) plan.images.push((p = { id: i.id, platform: platformOf(i), size: i.size, names: [], uses: [] }));
    if (!p.names.includes(s.image)) p.names.push(s.image);
    p.uses.push({ env: sb.env, service: s.name });
  }
}

/** The sandbox part of an archive (the module's header). */
export async function planSandboxes(project: LoadedProject, o: SandboxPlanOptions): Promise<SandboxPlan> {
  const folders = new Map<string, string>();
  const plan: SandboxPlan = { parts: [], folders, folderAs: (env) => folders.get(env), exclude: new Set(), add: [], replace: new Map(), images: [] };
  const taken = new Set(o.taken);
  const sandboxes = Object.values(project.sandboxes ?? {});
  if (!sandboxes.length) throw new EngineError('invalid', `project ${project.slug} has no sandbox: --with-sandbox has nothing to carry`);
  for (const sb of sandboxes) {
    if (!pathInside(sb.file, project.dir))
      throw new EngineError(
        'refused',
        `sandbox ${sb.env}: its sandbox.yaml lies outside the project (${showHiddenCharsLine(shownRef(project, sb.file))}): an archive carries a sandbox whose sandbox.yaml is the project's — move it into the project (and its sandboxes: entry), then export again`,
      );
    if (sb.manifest.provider === 'process') {
      plan.parts.push({ env: sb.env, provider: 'process', copied: [], rewritten: [], outside: await outsideRefs(project, sb), host_mounts: [], service_env_files: [], images: [] });
      continue;
    }
    if (o.images && o.share && !plan.docker) {
      try {
        plan.docker = await o.share.docker(o.policy);
      } catch (e) {
        throw new EngineError('refused', `sandbox ${sb.env}: docker is needed to save its images (${errorMessage(e)}) — start Docker, or export with --no-images`);
      }
      if (plan.docker.store === 'containerd')
        throw new EngineError(
          'refused',
          `sandbox ${sb.env}: this Docker keeps its images in containerd's image store, whose image ids are manifest digests: saving images for an archive there is not supported yet — export with --no-images, or switch Docker to its classic store`,
        );
    }
    plan.parts.push(await composePart(project, sb, o, plan, taken));
  }
  plan.images.sort((a, b) => (a.id < b.id ? -1 : 1));
  return plan;
}
