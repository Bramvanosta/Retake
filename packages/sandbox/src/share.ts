/**
 * A docker-compose sandbox handed over in a project archive (engine project-archive/): what docker says of its compose
 * files and images, the images saved by id and loaded back. The engine's Sandboxes port hands it out as `share`; the
 * engine never runs docker itself.
 *
 * - `docker`: Compose's and the daemon's versions, the daemon's platform, its data root, whether `docker save` takes
 *   `--platform` (Docker 25 and later).
 * - `compose`: `docker compose config --format json` of the sandbox (no container made): each service's image (or the
 *   name its build gives it), build context, bind mounts and env files (their key names, never a value); the files of
 *   its secrets and configs; the `include:` and `extends.file` the compose files name (never copied).
 * - `inspect`: an image's id, platform and size.
 * - `save`: `docker save [--platform <os/arch>] <image id>` gzipped into a new file — by id, so the tar names no tag.
 * - `load`: the file read strictly (image-tar.ts) before docker starts, then read again as it is written afresh as
 *   docker load's input — only the blobs its manifests reference, then Retake's own manifest.json, index.json and
 *   oci-layout, never the file's; a refusal kills docker before any naming file, so it loads nothing; its `Loaded image ID:` lines must be the ids expected and no tag
 *   named; the tags of this machine are read before and after: one that moved is put back, a new one removed, and an
 *   image it loaded that was not here before removed.
 * - `tag`: `docker tag <id> <tag>` (the engine names the tag: `retake-share-<slug>-…`).
 *
 * docker is found as the compose provider finds it (findDocker) and checked under the work's policy (startedProgram);
 * tests pass their own runner.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { errorMessage, parseYaml } from '@retake/core/base';
import { envFileKeys } from '@retake/core/sandbox';
import type { LoadedProject } from '@retake/core/project';
import type { WorkPolicy } from '@retake/core/policy';
import { dockerEnv, dockerReady, findDocker, firstErrorLine, runDocker } from './docker.js';
import type { DockerExec, DockerResult } from './docker.js';
import { SandboxError } from './errors.js';
import { parseShareConfig } from './compose-parse.js';
import type { ShareService } from './compose-parse.js';
import { composeArgs, composeProject, startedProgram } from './compose-project.js';
import { canonicalImageTar } from './image-tar.js';

/** What docker says of this machine. */
export interface DockerFacts {
  /** `docker compose version --short`. */
  compose: string;
  /** The daemon's version. */
  server: string;
  /** The daemon's `os/arch` (linux/arm64). */
  platform: string;
  /** Its data root (`docker info`), where the images are kept: a folder of the daemon's machine (Docker Desktop's VM). */
  root?: string;
  /** Whether `docker save` takes `--platform`. */
  savePlatform: boolean;
  /**
   * Docker's image store: the classic one (overlay2…), or containerd's (`docker info` names a containerd snapshotter),
   * whose image ids are manifest digests — not handed over yet.
   */
  store?: 'classic' | 'containerd';
}

/** An image as `docker image inspect` says it. */
export interface ImageFacts {
  id: string;
  os: string;
  arch: string;
  variant?: string;
  /** Bytes, uncompressed. */
  size: number;
}

/** One service, with the key names of its env files. */
export interface ShareFactsService extends ShareService {
  envFileKeys: Array<{ file: string; keys: string[] }>;
}

/** What a project archive needs of a docker-compose sandbox. */
export interface ShareFacts {
  /** The compose project's name. */
  project: string;
  /** The compose files, absolute (the trust override last when there is one). */
  files: string[];
  /** The env file `--env-file` reads, absolute, and the names it sets. */
  envFile?: string;
  envKeys: string[];
  services: ShareFactsService[];
  secretFiles: string[];
  configFiles: string[];
  /** The `include:` and `extends.file` paths the compose files name (as written). */
  includes: string[];
}

/** The images of a project's docker-compose sandboxes, for a project archive (the module's header). */
export interface SandboxShare {
  docker(policy: WorkPolicy, signal?: AbortSignal): Promise<DockerFacts>;
  compose(project: LoadedProject, env: string, policy: WorkPolicy): Promise<ShareFacts>;
  /** By name or id; null for an image this machine does not hold. */
  inspect(names: readonly string[], policy: WorkPolicy): Promise<Record<string, ImageFacts | null>>;
  save(id: string, o: { platform?: string; file: string; policy: WorkPolicy; signal?: AbortSignal; onBytes?: (n: number) => void }): Promise<{ bytes: number; sha256: string }>;
  /** `sha256`: of the file (the import's); `maxBytes`: its bytes once decompressed, at most (measured at import). */
  load(file: string, o: { expect: readonly string[]; sha256: string; maxBytes: number; policy: WorkPolicy; signal?: AbortSignal; onBytes?: (n: number) => void }): Promise<{ loaded: string[] }>;
  tag(id: string, tag: string, policy: WorkPolicy): Promise<void>;
}

/** How docker is run for a share: captured, or its standard output piped into a stream (`docker save`). */
export interface ShareDocker {
  run: DockerExec;
  pipe(args: string[], out: Writable, o?: { signal?: AbortSignal }): Promise<DockerResult>;
  /**
   * docker with its standard input written by `write` (`docker load` of the fresh tar): when `write` fails, docker is
   * killed before its input ends (it loads nothing), and the failure is returned as `error`.
   */
  feed(args: string[], write: (stdin: Writable) => Promise<void>, o?: { signal?: AbortSignal }): Promise<DockerResult & { writeError?: unknown }>;
}

/** docker under `policy`, as the compose provider runs it. */
export function shareDocker(policy: WorkPolicy, bin: string | null = findDocker()): ShareDocker {
  const program = () => {
    if (!bin) throw new SandboxError('docker-compose sandboxes need Docker: `docker` was not found (install Docker Desktop or OrbStack, or set RETAKE_DOCKER)');
    const checked = startedProgram(policy, bin, 'docker');
    if (checked.problem) throw new SandboxError(`docker-compose sandboxes: ${checked.problem}`);
    return checked;
  };
  return {
    run: (args, o) => {
      const p = program();
      return runDocker(p.program, args, { ...o, policy, ...(p.argv0 ? { argv0: p.argv0 } : {}) });
    },
    pipe: (args, out, o = {}) => {
      const p = program();
      const t0 = Date.now();
      return new Promise((resolve) => {
        const child = spawn(p.program, args, { ...(p.argv0 ? { argv0: p.argv0 } : {}), env: dockerEnv(policy), stdio: ['ignore', 'pipe', 'pipe'], ...(o.signal ? { signal: o.signal } : {}) });
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-64 * 1024)));
        const piped = pipeline(child.stdout, out).then(
          () => undefined,
          (e: unknown) => errorMessage(e),
        );
        let error: string | undefined;
        child.once('error', (e) => (error = e.message));
        child.once('close', (code) => {
          void piped.then((pipeError) => resolve({ code, stdout: '', stderr, ms: Date.now() - t0, ...(error || pipeError ? { error: error ?? pipeError } : {}) }));
        });
      });
    },
    feed: (args, write, o = {}) => {
      const p = program();
      const t0 = Date.now();
      return new Promise((resolve) => {
        const child = spawn(p.program, args, { ...(p.argv0 ? { argv0: p.argv0 } : {}), env: dockerEnv(policy), stdio: ['pipe', 'pipe', 'pipe'], ...(o.signal ? { signal: o.signal } : {}) });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout = (stdout + d).slice(-256 * 1024)));
        child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-64 * 1024)));
        child.stdin.on('error', () => undefined);
        let error: string | undefined;
        child.once('error', (e) => (error = e.message));
        const wrote = write(child.stdin).then(
          () => {
            child.stdin.end();
            return undefined;
          },
          (e: unknown) => {
            child.kill('SIGKILL');
            child.stdin.destroy();
            return e ?? new Error('the input failed');
          },
        );
        child.once('close', (code) => {
          void wrote.then((writeError) => resolve({ code, stdout, stderr, ms: Date.now() - t0, ...(error ? { error } : {}), ...(writeError ? { writeError } : {}) }));
        });
      });
    },
  };
}

const PROBE_MS = 30_000;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** The `include:` and `extends.file` paths of compose files (never copied into an archive: listed). */
function composeIncludes(files: readonly string[]): string[] {
  const out: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  for (const f of files) {
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(f, 'utf8')).value;
    } catch {
      continue;
    }
    if (!isObj(doc)) continue;
    const inc = doc.include;
    for (const i of typeof inc === 'string' ? [inc] : Array.isArray(inc) ? inc : []) {
      if (typeof i === 'string') out.push(i);
      else if (isObj(i)) for (const p of typeof i.path === 'string' ? [i.path] : Array.isArray(i.path) ? i.path : []) if (typeof p === 'string') out.push(p);
    }
    for (const svc of Object.values(isObj(doc.services) ? doc.services : {})) {
      if (isObj(svc) && isObj(svc.extends) && typeof svc.extends.file === 'string') out.push(svc.extends.file);
    }
  }
  return [...new Set(out)];
}

function keysOf(file: string): string[] {
  try {
    return envFileKeys(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** `docker save [--platform] <id>` gzipped into a new file (share.save). */
async function saveImage(dk: ShareDocker, id: string, so: { platform?: string; file: string; signal?: AbortSignal; onBytes?: (n: number) => void }): Promise<{ bytes: number; sha256: string }> {
  if (!IMAGE_ID.test(id)) throw new SandboxError(`not an image id: ${id.slice(0, 80)}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      so.onBytes?.(bytes);
      cb(null, chunk);
    },
  });
  const gzip = createGzip({ level: 6 });
  // Created exclusively before anything runs: an existing file is refused, never removed.
  const fh = await open(so.file, 'wx', 0o600);
  const written = pipeline(gzip, count, fh.createWriteStream());
  const r = await dk.pipe(['save', ...(so.platform ? ['--platform', so.platform] : []), id], gzip, so.signal ? { signal: so.signal } : {});
  const wrote = await written.then(
    () => undefined,
    (e: unknown) => errorMessage(e),
  );
  if (r.code !== 0 || r.error || wrote) {
    await rm(so.file, { force: true });
    throw new SandboxError(`docker save ${id.slice(7, 19)}: ${r.error ?? wrote ?? firstErrorLine(r)}`);
  }
  return { bytes, sha256: hash.digest('hex') };
}

/** Every tag of this machine and the image id it names (`<none>` left out). */
async function tagsHere(dk: ShareDocker): Promise<Map<string, string>> {
  const r = await dk.run(['image', 'ls', '--no-trunc', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}'], { timeoutMs: PROBE_MS });
  if (r.code !== 0) throw new SandboxError(`docker image ls: ${firstErrorLine(r)}`);
  const out = new Map<string, string>();
  for (const l of r.stdout.split('\n')) {
    const [tag, id] = l.trim().split(' ');
    if (tag && id && !tag.includes('<none>')) out.set(tag, id);
  }
  return out;
}

/** Every image id of this machine (`image ls -a -q`); refused when docker does not answer. */
async function idsHere(dk: ShareDocker): Promise<Set<string>> {
  const r = await dk.run(['image', 'ls', '-a', '-q', '--no-trunc'], { timeoutMs: PROBE_MS });
  if (r.code !== 0) throw new SandboxError(`docker image ls: ${firstErrorLine(r)}`);
  return new Set(
    r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * The tags of this machine after a load compared with before (the defence below the fresh tar: docker load should never
 * tag anything): a tag that moved or went is put back on its old id; a tag that appeared on an image this load created
 * (an id that was not here before) is removed — a tag on an image that was here before is left alone (the person may
 * have made it meanwhile) and said. Every docker answer is checked; what failed is said. Never removes an image.
 */
async function restoreTags(dk: ShareDocker, before: Map<string, string>, idsBefore: ReadonlySet<string>): Promise<{ changed: string[]; failed: string[] }> {
  const out = { changed: [] as string[], failed: [] as string[] };
  let after: Map<string, string>;
  try {
    after = await tagsHere(dk);
  } catch (e) {
    out.failed.push(`the tags of this machine could not be read after the load (${errorMessage(e)}): check them`);
    return out;
  }
  for (const tag of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(tag);
    const now = after.get(tag);
    if (was === now) continue;
    if (was) {
      const r = await dk.run(['tag', was, tag], { timeoutMs: PROBE_MS });
      if (r.code === 0) out.changed.push(`${tag} put back on ${was.slice(7, 19)}`);
      else out.failed.push(`${tag} could not be put back on ${was.slice(7, 19)} (${firstErrorLine(r)})`);
    } else if (now && !idsBefore.has(now)) {
      const r = await dk.run(['image', 'rm', '--no-prune', tag], { timeoutMs: PROBE_MS });
      if (r.code === 0) out.changed.push(`${tag} removed`);
      else out.failed.push(`${tag} could not be removed (${firstErrorLine(r)})`);
    } else if (now) out.changed.push(`${tag} appeared on ${now.slice(7, 19)}, an image here before: left alone`);
  }
  return out;
}

/**
 * The file read strictly and written afresh into docker load's input (image-tar.ts: docker never sees the file's own
 * naming files), its answer checked: exactly the ids expected (`Loaded image ID:` lines), no tag; every tag of this
 * machine that moved put back and every new one removed; an image it loaded besides that was not here removed.
 */
async function loadImage(
  dk: ShareDocker,
  file: string,
  lo: { expect: readonly string[]; sha256: string; maxBytes: number; signal?: AbortSignal; onBytes?: (n: number) => void },
): Promise<{ loaded: string[] }> {
  const expect = [...new Set(lo.expect)].sort();
  if (!expect.length || expect.some((id) => !IMAGE_ID.test(id))) throw new SandboxError('the images to load are named by their ids (sha256:…)');
  // A first read, writing nothing: a refused file never reaches docker, and the blobs to write are known.
  const first = await canonicalImageTar(createReadStream(file), undefined, { expect, maxBytes: lo.maxBytes, sha256: lo.sha256, ...(lo.onBytes ? { onBytes: lo.onBytes } : {}) }).catch((e: unknown) => {
    throw new SandboxError(`the image file is refused, nothing loaded: ${errorMessage(e)}`);
  });
  // Both listings before the load, or no load: what is restored and removed after is judged against them.
  const before = await tagsHere(dk);
  const ids = await idsHere(dk);
  const r = await dk.feed(
    ['load'],
    async (stdin) => {
      // Read again as it is written: only the referenced blobs, every check again, the naming files (Retake's) last.
      await canonicalImageTar(createReadStream(file), stdin, { expect, maxBytes: lo.maxBytes, sha256: lo.sha256, only: first.referenced, ...(lo.onBytes ? { onBytes: lo.onBytes } : {}) });
    },
    lo.signal ? { signal: lo.signal } : {},
  );
  const lines = `${r.stdout}\n${r.stderr}`.split('\n');
  const loaded = [...new Set(lines.flatMap((l) => /Loaded image ID:\s*(sha256:[0-9a-f]{64})/.exec(l)?.[1] ?? []))].sort();
  const named = [...new Set(lines.flatMap((l) => /Loaded image:\s*(\S+)/.exec(l)?.[1] ?? []))];
  const restored = await restoreTags(dk, before, ids);
  const touched = restored.changed.filter((c) => !c.endsWith('left alone'));
  const ok = !r.writeError && r.code === 0 && !named.length && !touched.length && !restored.failed.length && loaded.length === expect.length && loaded.every((id, i) => id === expect[i]);
  if (!ok) {
    // Only images this load created (absent before) are removed, each answer checked.
    for (const id of loaded) {
      if (ids.has(id)) continue;
      const rm = await dk.run(['image', 'rm', id], { timeoutMs: PROBE_MS });
      if (rm.code !== 0) restored.failed.push(`the image ${id.slice(7, 19)} it loaded could not be removed (${firstErrorLine(rm)})`);
    }
    const why = r.writeError
      ? `the image file is refused, nothing loaded: ${errorMessage(r.writeError)}`
      : r.code !== 0
        ? firstErrorLine(r)
        : named.length || touched.length
          ? 'it named a tag'
          : restored.failed.length
            ? 'the tags of this machine could not all be checked'
            : `it loaded ${loaded.join(', ') || 'nothing'}, not ${expect.join(', ')}`;
    const words = /no space left/i.test(why) ? "Docker's disk is full (no space left on device): free space in Docker, then load again" : why;
    const said = [
      ...(restored.changed.length ? [`the tags of this machine it touched: ${restored.changed.join('; ')}`] : []),
      ...(restored.failed.length ? [`FAILED: ${restored.failed.join('; ')}`] : []),
    ];
    throw new SandboxError(`docker load refused: ${words}${said.length ? ` (${said.join(' — ')})` : ''}`);
  }
  return { loaded };
}

/** A SandboxShare on `docker` (default: shareDocker under each call's policy). */
export function createSandboxShare(o: { docker?: (policy: WorkPolicy) => ShareDocker } = {}): SandboxShare {
  const d = o.docker ?? ((policy: WorkPolicy) => shareDocker(policy));
  const fail = (what: string, r: DockerResult) => new SandboxError(`${what}: ${firstErrorLine(r)}`);
  return {
    async docker(policy, signal) {
      const dk = d(policy);
      const info = await dockerReady(dk.run, 'docker', signal);
      const v = await dk.run(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], { timeoutMs: PROBE_MS });
      const root = await dk.run(['info', '--format', '{{.DockerRootDir}}'], { timeoutMs: PROBE_MS });
      const help = await dk.run(['save', '--help'], { timeoutMs: PROBE_MS });
      const store = await dk.run(['info', '--format', '{{json .DriverStatus}}'], { timeoutMs: PROBE_MS });
      return {
        compose: info.compose,
        server: info.server,
        platform: v.code === 0 ? v.stdout.trim() : 'unknown',
        ...(root.code === 0 && root.stdout.trim().startsWith('/') ? { root: root.stdout.trim() } : {}),
        savePlatform: /--platform\b/.test(help.stdout + help.stderr),
        store: /io\.containerd\.snapshotter/.test(store.stdout) ? 'containerd' : 'classic',
      };
    },

    async compose(project, env, policy) {
      const sandbox = project.sandboxes?.[env];
      if (!sandbox) throw new SandboxError(`${env} is not a sandbox of project ${project.slug}`);
      if (sandbox.manifest.provider !== 'docker-compose') throw new SandboxError(`sandbox ${env} is a ${sandbox.manifest.provider} sandbox: it has no compose files`);
      const ref = composeProject(project, sandbox);
      const r = await d(policy).run([...composeArgs(ref), 'config', '--format', 'json'], {
        timeoutMs: PROBE_MS,
        cwd: ref.dir,
        ...(ref.overrideText !== undefined ? { input: ref.overrideText } : {}),
        ...(ref.envKeys?.length ? { unset: ref.envKeys } : {}),
        ...(ref.pass?.length ? { pass: ref.pass } : {}),
      });
      if (r.code !== 0) throw fail(`sandbox ${env}: docker compose config`, r);
      const cfg = parseShareConfig(r.stdout, ref.name);
      return {
        project: ref.name,
        files: ref.files,
        ...(ref.envFile ? { envFile: ref.envFile } : {}),
        envKeys: ref.envKeys ?? [],
        services: cfg.services.map((s) => ({ ...s, envFileKeys: s.envFiles.map((file) => ({ file, keys: keysOf(file) })) })),
        secretFiles: cfg.secretFiles,
        configFiles: cfg.configFiles,
        includes: composeIncludes(ref.files),
      };
    },

    async inspect(names, policy) {
      const out: Record<string, ImageFacts | null> = {};
      for (const n of names) {
        const r = await d(policy).run(['image', 'inspect', '--format', '{{json .}}', n], { timeoutMs: PROBE_MS });
        if (r.code !== 0) {
          out[n] = null;
          continue;
        }
        const j = JSON.parse(r.stdout.trim().split('\n')[0] ?? '{}') as { Id?: string; Os?: string; Architecture?: string; Variant?: string; Size?: number };
        if (!j.Id || !IMAGE_ID.test(j.Id)) throw new SandboxError(`docker image inspect ${n}: no image id in its answer`);
        out[n] = { id: j.Id, os: j.Os ?? 'linux', arch: j.Architecture ?? 'unknown', ...(j.Variant ? { variant: j.Variant } : {}), size: Number(j.Size ?? 0) };
      }
      return out;
    },

    save: (id, so) => saveImage(d(so.policy), id, so),
    load: (file, lo) => loadImage(d(lo.policy), file, lo),

    async tag(id, tag, policy) {
      if (!IMAGE_ID.test(id) || !/^retake-[a-z0-9][a-z0-9_.-]{0,126}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag))
        throw new SandboxError(`refused: a share tag is retake-…:<tag> of an image id (${tag.slice(0, 80)})`);
      // Never re-point a tag: one that names another image is refused.
      const was = await d(policy).run(['image', 'inspect', '--format', '{{.Id}}', tag], { timeoutMs: PROBE_MS });
      if (was.code === 0 && was.stdout.trim() !== id) throw new SandboxError(`refused: the tag ${tag} names another image here (${was.stdout.trim().slice(7, 19)}): never re-pointed`);
      if (was.code === 0) return;
      const r = await d(policy).run(['tag', id, tag], { timeoutMs: PROBE_MS });
      if (r.code !== 0) throw fail(`docker tag ${tag}`, r);
    },
  };
}
