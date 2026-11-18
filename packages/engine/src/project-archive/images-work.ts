/**
 * The images a project archive carried for its sandboxes, loaded into Docker — at `retake project trust` only, after a
 * person's yes (or later with `retake project trust <slug> --images`), never at import. A person's act only.
 *
 * What runs is decided from the files, never the manifest: the services each sandbox's compose files declare are read
 * by Retake (compose-read.ts), and each carried image's services (signed with the trust) must be among them, with the
 * image name their compose file gives them. For each image not loaded yet: the Sandboxes port's `share.load` (the
 * sandbox package: the file read once, strictly, its sha256 and its decompressed size the import's, written afresh for
 * `docker load` with Retake's own naming files; the tags of this machine checked before and after), then tagged here
 * `retake-share-<slug>-<env>-<service>:<12 hex of its id>` for each service that runs it, recorded (the mark's signed
 * `loaded` stanza) and its file removed. Once every carried image is loaded, each sandbox's compose override is written
 * into the project's sandbox state (core sandboxImagesOverride) for EVERY service its compose files declare:
 * `build: !reset null` and `pull_policy: never`, its carried tag where it has one — nothing is ever built or pulled; a
 * service whose image is neither carried nor on this machine is recorded as missing, and starting that sandbox is
 * refused until it is there (guard.ts). The override's sha256 is signed in the mark: the compose provider reads it only
 * while its bytes match.
 *
 * `!reset` needs Docker Compose v2.24 or later: with an older one, or no Docker running, or a refused load, the images
 * wait (the answer says why; what loaded before stays recorded). Docker's disk: where its data root is a folder this
 * machine reads (Linux), its free space is checked against the images' sizes as measured at import; Docker Desktop and
 * OrbStack keep it in a VM — the answer says the size it needs there, an estimate.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { errorMessage, showHiddenCharsLine } from '@retake/core/base';
import { sandboxImagesOverride } from '@retake/core/project';
import type { WorkPolicy } from '@retake/core/policy';
import type { SandboxShare } from '@retake/sandbox/types';
import type { CallerTrust } from '../caller.js';
import type { EngineEnv } from '../env.js';
import { EngineError } from '../errors.js';
import type { OpenedWorkspace } from '../workspace.js';
import { readProjectSubsets, subsetProblems, usesProblem } from './compose-read.js';
import type { SandboxSubset } from './compose-read.js';
import { importImagesDir, importTrust, projectPlace, signedLoaded, writeLoaded } from './trust.js';
import type { ImagesLoaded, MarkImage } from './trust.js';

/** The oldest Compose whose override reading takes `!reset` (2.24.0). */
export const MIN_COMPOSE_RESET: readonly number[] = [2, 24, 0];

export interface ImagesLoadResult {
  project: string;
  /** The images loaded now, each with the tags given it. */
  loaded: Array<{ id: string; tags: string[] }>;
  /** The overrides written (absolute files). */
  overrides: string[];
  /** The services whose image is neither carried nor on this machine (their sandbox does not start). */
  missing: string[];
  /** Why images still wait (no Docker, an old Compose, a refused load), when some do. */
  waiting?: string;
  /** What a person should know (Docker's disk). */
  notes: string[];
}

const clean = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');

/** The tag an image of an imported project gets here: `retake-share-<slug>-<env>-<service>:<its whole id, 64 hex>`. */
export function shareTag(slug: string, env: string, service: string, id: string): string {
  const repo = `retake-share-${clean(slug)}-${clean(env)}-${clean(service)}`.slice(0, 120).replace(/[-_.]+$/, '');
  return `${repo}:${id.slice('sha256:'.length)}`;
}

/** The compose override of one sandbox: every service never built nor pulled, its carried tag where it has one. */
export function overrideText(services: ReadonlyArray<{ service: string; tag?: string }>): string {
  const lines = [
    '# Written by retake project trust: the images this project archive carried, loaded and tagged on this machine.',
    '# Every service runs as is, never built nor pulled (`!reset` needs Docker Compose v2.24 or later).',
    'services:',
  ];
  for (const s of [...services].sort((a, b) => (a.service < b.service ? -1 : 1))) {
    lines.push(`  ${JSON.stringify(s.service)}:`, ...(s.tag ? [`    image: ${JSON.stringify(s.tag)}`] : []), '    build: !reset null', '    pull_policy: never');
  }
  return `${lines.join('\n')}\n`;
}

const versionParts = (v: string): number[] => (/(\d+)\.(\d+)(?:\.(\d+))?/.exec(v) ?? []).slice(1, 4).map((x) => Number(x ?? 0));
function atLeast(v: string, min: readonly number[]): boolean {
  const p = versionParts(v);
  if (!p.length) return true;
  for (let i = 0; i < min.length; i++) if ((p[i] ?? 0) !== min[i]) return (p[i] ?? 0) > min[i]!;
  return true;
}

const mb = (n: number): string => `${Math.ceil(n / 1e6)} MB`;

/** Docker's disk: checked where its data root is readable here (a refusal in words), an estimate note otherwise. */
export async function diskNote(root: string | undefined, need: number, slug: string, stat: typeof statfs = statfs): Promise<string | undefined> {
  const s = root ? await stat(root).catch(() => undefined) : undefined;
  if (!s) return `the images need about ${mb(need)} on Docker's disk (an estimate; Docker Desktop and OrbStack keep it in their VM, which this check does not read)`;
  const free = Number(s.bavail) * Number(s.bsize);
  if (free < need) throw new EngineError('refused', `Docker's disk (${root}) has ${mb(free)} free, the images need ${mb(need)}: free space there, then retake project trust ${slug} --images`);
  return undefined;
}

/** The overrides of every sandbox and its missing services, once every carried image is loaded. */
async function writeOverrides(
  slug: string,
  dir: string,
  reads: readonly SandboxSubset[],
  images: readonly MarkImage[],
  o: { share: SandboxShare; policy: WorkPolicy },
): Promise<{ files: string[]; overrides: Record<string, string>; missing: ImagesLoaded['missing'] }> {
  const out = { files: [] as string[], overrides: {} as Record<string, string>, missing: [] as ImagesLoaded['missing'] };
  const tagOf = (env: string, service: string) => {
    const i = images.find((x) => x.uses.some((u) => u.env === env && u.service === service));
    return i ? shareTag(slug, env, service, i.id) : undefined;
  };
  const names = [...new Set(reads.flatMap((r) => r.services.filter((s) => !tagOf(r.env, s.name) && s.image).map((s) => s.image!)))];
  const here = names.length ? await o.share.inspect(names, o.policy) : {};
  for (const r of reads) {
    if (!r.services.length) continue;
    const services = r.services.map((s) => {
      const tag = tagOf(r.env, s.name);
      // (A built service without a carried image is outside the subset on an import: never here.)
      if (!tag && (!s.image || !here[s.image]))
        out.missing.push({
          env: r.env,
          service: s.name.slice(0, 200),
          image: (s.image ?? '').slice(0, 300),
          why: `its image ${s.image ?? '(none)'} is neither in the archive nor on this machine, and the override never pulls`.slice(0, 500),
        });
      return { service: s.name, ...(tag ? { tag } : {}) };
    });
    const file = sandboxImagesOverride(dir, r.env);
    const text = overrideText(services);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
    out.files.push(file);
    out.overrides[r.env] = createHash('sha256').update(text).digest('hex');
  }
  return out;
}

/** Load the images an imported, trusted project waits for (the module's header). */
export async function loadImportImages(
  ws: OpenedWorkspace,
  slug: string,
  o: { trust: CallerTrust; env: EngineEnv; now: string; share: SandboxShare | undefined; policy: WorkPolicy; onProgress?: (line: string) => void },
): Promise<ImagesLoadResult> {
  if (o.trust !== 'author') throw new EngineError('refused', "a person loads an imported project's images, in a terminal: retake project trust <slug> --images");
  const at = projectPlace(ws, slug);
  const t = await importTrust(at, o.env);
  if (t.state !== 'trusted')
    throw new EngineError('refused', `${showHiddenCharsLine(slug)} is not trusted: its images are loaded once a person trusts it (retake project trust ${showHiddenCharsLine(slug)})`);
  const images: MarkImage[] = t.mark.images ?? [];
  const out: ImagesLoadResult = { project: slug, loaded: [], overrides: [], missing: [], notes: [] };
  if (!images.length) return out;
  const before = await signedLoaded(t.mark, o.env);
  const done: Record<string, string> = { ...(before?.images ?? {}) };
  const wait = (why: string): ImagesLoadResult => ({ ...out, waiting: `${why} — the images wait: retake project trust ${slug} --images loads them` });
  const reads = await readProjectSubsets(at.dir, { mode: 'import', carried: (e, sv) => images.some((i) => i.uses.some((u) => u.env === e && u.service === sv)) });
  const problem =
    subsetProblems(reads) ??
    usesProblem(
      images.flatMap((i) => i.uses),
      reads,
    );
  if (problem) return wait(`the sandbox is not handed over: ${problem}`);
  if (!o.share) return wait("this Retake's sandboxes load no image");
  const docker = await o.share.docker(o.policy).catch((e: unknown) => e as Error);
  if (docker instanceof Error) return wait(`Docker is not ready (${docker.message})`);
  if (docker.store === 'containerd')
    return wait(
      "this Docker keeps its images in containerd's image store, whose image ids are not the ones an archive records: loading an archive's images there is not supported yet (switch Docker to its classic store, or build the images here)",
    );
  if (!atLeast(docker.compose, MIN_COMPOSE_RESET))
    return wait(
      `the override that keeps the images from being built or pulled needs Docker Compose v${MIN_COMPOSE_RESET.join('.')} or later (\`build: !reset null\`), this one is ${docker.compose}: update Docker`,
    );
  const pending = images.filter((i) => !done[i.id]);
  try {
    const note = await diskNote(
      docker.root,
      pending.reduce((n, i) => n + i.tar_bytes, 0),
      slug,
    );
    if (note && pending.length) out.notes.push(note);
  } catch (e) {
    return wait(errorMessage(e));
  }
  const dir = importImagesDir(ws.root, slug);
  const record = (extra: Partial<ImagesLoaded> = {}) => writeLoaded(ws.root, slug, { at: o.now, images: done, overrides: before?.overrides ?? {}, missing: before?.missing ?? [], ...extra }, o.env);
  for (const [n, img] of pending.entries()) {
    const file = join(dir, img.file);
    o.onProgress?.(`loading image ${n + 1}/${pending.length} (${img.id.slice(7, 19)}, ${mb(img.tar_bytes)})`);
    try {
      await o.share.load(file, {
        expect: [img.id],
        sha256: img.sha256,
        maxBytes: img.tar_bytes,
        policy: o.policy,
        onBytes: (b) => o.onProgress?.(`loading image ${n + 1}/${pending.length}: ${mb(b)} of ${mb(img.bytes)} read`),
      });
      const tags = [...new Set(img.uses.map((u) => shareTag(slug, u.env, u.service, img.id)))];
      for (const tag of tags) await o.share.tag(img.id, tag, o.policy);
      done[img.id] = o.now;
      await record();
      await rm(file, { force: true });
      out.loaded.push({ id: img.id, tags });
    } catch (e) {
      return wait(`the image ${img.id.slice(7, 19)} is refused (${errorMessage(e)})`);
    }
  }
  const w = await writeOverrides(slug, at.dir, reads, images, { share: o.share, policy: o.policy });
  await record({ overrides: w.overrides, missing: w.missing });
  out.overrides = w.files;
  out.missing = w.missing.map((m) => `sandbox ${showHiddenCharsLine(m.env)}: service ${showHiddenCharsLine(m.service)} — ${showHiddenCharsLine(m.why)}`);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  return out;
}
