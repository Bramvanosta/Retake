/**
 * R-SHR-42, R-SHR-44: a sandbox's images in a project archive, the sandbox package's side (share.ts, image-tar.ts),
 * without Docker (a fake runner records every call):
 * - the tar read before `docker load`: a save by id passes; a tag anywhere (RepoTags, an index annotation, a
 *   repositories file) or another image id is refused before docker is called; gzip, pax sizes, base-256 sizes and
 *   GNU long names read; a broken checksum refused;
 * - load: the very descriptor checked is docker load's input; its `Loaded image ID:` lines must be the ids expected —
 *   otherwise what it loaded that was not here before is removed and the load refused;
 * - save: by id, `--platform` when given, gzipped into a new file (never over one), removed on a failure;
 * - compose: what `docker compose config --format json` says, read (images, builds, bind mounts, env files and their
 *   key names, secrets and configs, includes); tag: only a `retake-…` tag of an image id;
 * - core rewriteSandboxCompose keeps the rest of sandbox.yaml.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import { loadProject } from '@retake/core/io';
import { envFileKeys, rewriteSandboxCompose } from '@retake/core/sandbox';
import { sandboxImagesOverride } from '@retake/core/project';
import { composeArgs, composeProject } from '../src/compose-project.js';
import { parseYaml } from '@retake/core/base';
import { createSandboxShare } from '../src/share.js';
import type { ShareDocker } from '../src/share.js';
import { canonicalImageTar, strictJson } from '../src/image-tar.js';
import type { CanonicalOptions } from '../src/image-tar.js';
import type { DockerResult, DockerRunOptions } from '../src/docker.js';

const ID = `sha256:${'a'.repeat(64)}`;
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v));

/** One tar header and its padded data: ustar unless `gnu` (the GNU magic, its atime field where ustar has the prefix). */
function entry(name: string, data: Buffer, o: { type?: string; big?: boolean; gnu?: boolean; link?: string; prefix?: string } = {}): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  if (o.big) {
    h[124] = 0x80;
    h.writeUIntBE(data.length, 124 + 12 - 6, 6);
  } else h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write(o.type ?? '0', 156);
  if (o.link) h.write(o.link, 157);
  if (o.gnu) {
    h.write('ustar  \0', 257);
    h.write('00000000001\0', 345);
  } else {
    h.write('ustar\0', 257);
    h.write('00', 263);
    if (o.prefix) h.write(o.prefix, 345);
  }
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const pax = (records: Record<string, string>): Buffer => {
  const body = Object.entries(records)
    .map(([k, v]) => {
      const rest = ` ${k}=${v}\n`;
      let n = rest.length + 1;
      while (`${n}${rest}`.length !== n) n++;
      return `${n}${rest}`;
    })
    .join('');
  return entry('PaxHeaders/x', Buffer.from(body), { type: 'x' });
};
const end = Buffer.alloc(1024);

/** A synthetic by-id docker save: a config, a layer, an OCI manifest, index.json, manifest.json, oci-layout (and a legacy config nothing references). */
function image(o: { manifest?: unknown; index?: unknown; extra?: Buffer[]; before?: Buffer[]; layerAs?: 'pax' | 'base256' } = {}) {
  const config = json({ architecture: 'arm64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } });
  const layer = Buffer.alloc(3000, 7);
  const legacy = json({ id: 'legacy' });
  const cfg = sha(config);
  const lay = sha(layer);
  const man = json({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${cfg}`, size: config.length },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: `sha256:${lay}`, size: layer.length }],
  });
  const manHex = sha(man);
  const id = `sha256:${cfg}`;
  const manifest = o.manifest ?? [
    {
      Config: `blobs/sha256/${cfg}`,
      RepoTags: null,
      Layers: [`blobs/sha256/${lay}`],
      LayerSources: { [`sha256:${lay}`]: { mediaType: 'application/vnd.oci.image.layer.v1.tar', size: layer.length, digest: `sha256:${lay}` } },
    },
  ];
  const index = o.index ?? {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${manHex}`, size: man.length }],
  };
  const tar = Buffer.concat([
    ...(o.before ?? []),
    entry('blobs/', Buffer.alloc(0), { type: '5' }),
    entry('blobs/sha256/', Buffer.alloc(0), { type: '5' }),
    ...(o.layerAs === 'pax'
      ? // The layer's own header says 0 bytes: the pax size (Go writes one for a layer over 8 GiB) is the one read.
        [pax({ size: String(layer.length), mtime: '1.5' }), entry(`blobs/sha256/${lay}`, Buffer.alloc(0)), layer, Buffer.alloc(512 - (layer.length % 512))]
      : [entry(`blobs/sha256/${lay}`, layer, { big: o.layerAs === 'base256' })]),
    entry(`blobs/sha256/${manHex}`, man),
    entry(`blobs/sha256/${sha(legacy)}`, legacy),
    entry(`blobs/sha256/${cfg}`, config),
    entry('index.json', json(index)),
    entry('manifest.json', json(manifest)),
    entry('oci-layout', json({ imageLayoutVersion: '1.0.0' })),
    ...(o.extra ?? []),
    end,
  ]);
  return { tar, id, cfg, lay, manHex, legacy: sha(legacy), manifest, index };
}

/** A save whose OCI manifest (reached from index.json) names a layer with `urls`. */
function nestedUrls(foreign?: string): Buffer {
  const base = image();
  const layer = foreign
    ? { mediaType: foreign, digest: `sha256:${base.lay}`, size: 3000 }
    : { mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: `sha256:${base.lay}`, size: 3000, urls: ['https://example.com/l'] };
  const man = json({ schemaVersion: 2, config: { digest: `sha256:${base.cfg}`, size: 1 }, layers: [layer] });
  return image({
    index: { schemaVersion: 2, manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${sha(man)}`, size: man.length }] },
    extra: [entry(`blobs/sha256/${sha(man)}`, man)],
  }).tar;
}

/** The names and the files of a tar Retake wrote (ustar, no pax). */
function readOut(b: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (let at = 0; at + 512 <= b.length; ) {
    const h = b.subarray(at, at + 512);
    if (h.every((x) => x === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(h.subarray(124, 136).toString('latin1').replace(/\0.*$/s, ''), 8);
    out.set(name, b.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Collects what is written to it. */
class Sink extends Writable {
  readonly parts: Buffer[] = [];
  override _write(c: Buffer, _e: BufferEncoding, cb: () => void): void {
    this.parts.push(Buffer.from(c));
    cb();
  }
  get bytes(): Buffer {
    return Buffer.concat(this.parts);
  }
}

const canon = (b: Buffer, expect: string[], out?: Writable, o: Partial<CanonicalOptions> = {}) => canonicalImageTar(Readable.from([b]), out, { expect, maxBytes: 1 << 30, ...o });

describe('the image tar read strictly and written afresh (image-tar.ts)', () => {
  it("a by-id save passes, gzipped or not; docker gets Retake's own naming files and only the referenced blobs", async () => {
    const img = image();
    for (const input of [img.tar, gzipSync(img.tar)]) {
      const sink = new Sink();
      const r = await canon(input, [img.id], sink);
      expect(r.ids).toEqual([img.id]);
      expect([...r.referenced].sort()).toEqual([img.cfg, img.lay, img.manHex].sort());
      const out = readOut(sink.bytes);
      expect([...out.keys()]).toEqual([
        'blobs/',
        'blobs/sha256/',
        `blobs/sha256/${img.lay}`,
        `blobs/sha256/${img.manHex}`,
        `blobs/sha256/${img.legacy}`,
        `blobs/sha256/${img.cfg}`,
        'index.json',
        'manifest.json',
        'oci-layout',
      ]);
      expect(JSON.parse(out.get('manifest.json')!.toString())).toEqual([{ Config: `blobs/sha256/${img.cfg}`, RepoTags: null, Layers: [`blobs/sha256/${img.lay}`] }]);
      // The second read writes only what the first found referenced (the legacy config is left out).
      const only = new Sink();
      await canon(input, [img.id], only, { only: r.referenced });
      expect([...readOut(only.bytes).keys()]).not.toContain(`blobs/sha256/${img.legacy}`);
      expect(JSON.parse(readOut(only.bytes).get('index.json')!.toString())).toEqual({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${img.manHex}`, size: (img.index as { manifests: Array<{ size: number }> }).manifests[0]!.size }],
      });
    }
  });

  it("refuses every hostile shape of the reviews' probes before any naming file reaches docker", async () => {
    const img = image();
    const tagged = json([{ Config: `blobs/sha256/${img.cfg}`, RepoTags: ['retake-test-victim:1'], Layers: [`blobs/sha256/${img.lay}`] }]);
    const cases: Array<[string, Buffer, RegExp]> = [
      [
        'a lowercase repotags',
        image({ manifest: [{ Config: `blobs/sha256/${img.cfg}`, repotags: ['postgres:17-alpine'], Layers: [`blobs/sha256/${img.lay}`] }] }).tar,
        /the key "repotags" spelt otherwise than RepoTags/,
      ],
      [
        'two keys equal ignoring case',
        image({ manifest: [{ Config: `blobs/sha256/${img.cfg}`, RepoTags: null, Repotags: ['x:1'], Layers: [`blobs/sha256/${img.lay}`] }] }).tar,
        /twice \(ignoring case\)/,
      ],
      ['x/../manifest.json after the benign one', image({ extra: [entry('x/../manifest.json', tagged)] }).tar, /a name that is not clean \("x\/\.\.\/manifest\.json"\)/],
      ['./x/../repositories', image({ extra: [entry('./x/../repositories', json({ postgres: { '17': img.cfg } }))] }).tar, /a name that is not clean/],
      ['a symbolic link', image({ extra: [entry('manifest.json', Buffer.alloc(0), { type: '2', link: `blobs/sha256/${img.cfg}` })] }).tar, /an entry of type "2"/],
      ['a hard link', image({ extra: [entry('manifest.json', Buffer.alloc(0), { type: '1', link: `blobs/sha256/${img.cfg}` })] }).tar, /an entry of type "1"/],
      ['a GNU header (the atime trap)', image({ extra: [entry('manifest.json', tagged, { gnu: true })] }).tar, /not ustar or pax \(a GNU header\?\)/],
      ['a contiguous file (type 7)', image({ extra: [entry('manifest.json', tagged, { type: '7' })] }).tar, /an entry of type "7"/],
      ['a GNU long name', image({ before: [entry('././@LongLink', Buffer.from('manifest.json\0'), { type: 'L' })] }).tar, /an entry of type "L"/],
      ['a global pax header', image({ before: [entry('g', Buffer.from('13 path=a.json\n'), { type: 'g' })] }).tar, /an entry of type "g"/],
      ['a pax key of another kind', image({ before: [pax({ linkpath: 'x' }), entry('blobs/', Buffer.alloc(0), { type: '5' })] }).tar, /a pax record of another kind \(linkpath\)/],
      ['a NUL in a pax path', image({ before: [pax({ path: 'a\0b' }), entry('x', Buffer.alloc(0))] }).tar, /NUL/],
      ['a repositories file', image({ extra: [entry('repositories', json({ postgres: { '17': img.cfg } }))] }).tar, /a file a docker save by id never writes \("repositories"\)/],
      ['two names equal once folded', image({ extra: [entry(`blobs/sha256/${img.cfg}`, Buffer.from('x'))] }).tar, /two entries named/],
      ['a tagged manifest', image({ manifest: JSON.parse(tagged.toString()) }).tar, /names tags \(RepoTags\)/],
      [
        'an index annotation of a name',
        image({ index: { manifests: [{ mediaType: 'm', digest: `sha256:${img.manHex}`, size: 1, annotations: { 'io.containerd.image.name': 'docker.io/library/postgres:17' } }] } }).tar,
        /index\.json names an image/,
      ],
      [
        'a foreign layer',
        image({ manifest: [{ Config: `blobs/sha256/${img.cfg}`, RepoTags: null, Layers: [`blobs/sha256/${img.lay}`], LayerSources: { x: { urls: ['https://example.com/l'] } } }] }).tar,
        /foreign layer/,
      ],
      ['a blob whose name is not its sha256', image({ extra: [entry(`blobs/sha256/${'c'.repeat(64)}`, Buffer.from('not c'))] }).tar, /does not hold the bytes its name says/],
      ['data after a single end block', Buffer.concat([image().tar.subarray(0, image().tar.length - 1024), Buffer.alloc(512), entry('manifest.json', tagged), end]), /data after a single end block/],
      ['another file name', image({ extra: [entry('evil.json', tagged)] }).tar, /never writes \("evil\.json"\)/],
      ['a nested manifest layer fetched elsewhere', nestedUrls(), /a manifest names a layer fetched elsewhere \(urls\)/],
      ['a nested foreign layer', nestedUrls('application/vnd.docker.image.rootfs.foreign.diff.tar.gzip'), /a manifest names a foreign layer/],
    ];
    for (const [what, t, words] of cases) {
      const sink = new Sink();
      await expect(canon(t, [img.id], sink), what).rejects.toThrow(words);
      expect(readOut(sink.bytes).has('manifest.json'), what).toBe(false);
      expect(sink.bytes.includes(Buffer.from('victim')), what).toBe(false);
    }
    await expect(canon(image().tar, [`sha256:${'b'.repeat(64)}`])).rejects.toThrow(/holds the images sha256:[0-9a-f]+, not sha256:b+/);
  });

  it("refuses more bytes than its image once decompressed, a sha256 other than the import's, a changed blob set", async () => {
    const img = image();
    await expect(canon(gzipSync(img.tar), [img.id], undefined, { maxBytes: 2048 })).rejects.toThrow(/more than 2048 bytes once decompressed/);
    await expect(canon(img.tar, [img.id], undefined, { sha256: 'f'.repeat(64) })).rejects.toThrow(/recorded at import \(sha256\)/);
    expect((await canon(img.tar, [img.id], undefined, { sha256: sha(img.tar) })).sha256).toBe(sha(img.tar));
    await expect(canon(img.tar, [img.id], undefined, { only: new Set([img.cfg]) })).rejects.toThrow(/changed while it was read/);
    // pax sizes and base-256 sizes read; a broken checksum refused.
    for (const layerAs of ['pax', 'base256'] as const) {
      const v = image({ layerAs });
      expect((await canon(v.tar, [v.id])).referenced.has(v.lay), layerAs).toBe(true);
    }
    const broken = Buffer.from(img.tar);
    broken[0] ^= 0xff;
    await expect(canon(broken, [img.id])).rejects.toThrow(/checksum/);
  });

  it('strictJson refuses duplicate keys and case variants of known ones', () => {
    expect(strictJson('{"a":1,"b":[true,null,"x"]}', [])).toEqual({ a: 1, b: [true, null, 'x'] });
    expect(() => strictJson('{"a":1,"a":2}', [])).toThrow(/twice/);
    expect(() => strictJson('{"repotags":[]}', ['RepoTags'])).toThrow(/spelt otherwise/);
    // Folded as Go folds names: ſ (U+017F) is s.
    expect(() => strictJson('{"RepoTag\u017f":["x:1"]}', ['RepoTags'])).toThrow(/spelt otherwise than RepoTags/);
    expect(() => strictJson('{"a":1} x', [])).toThrow(/text after/);
  });
});

/** A fake docker: answers by the args, records every call; `feed` collects what is written to docker load. */
function fakeDocker(answers: (args: string[], n: number) => Partial<DockerResult>, piped?: Buffer): { docker: ShareDocker; calls: Array<{ args: string[] }>; fed: Sink[] } {
  const calls: Array<{ args: string[] }> = [];
  const fed: Sink[] = [];
  const done = (r: Partial<DockerResult>): DockerResult => ({ code: 0, stdout: '', stderr: '', ms: 1, ...r });
  return {
    calls,
    fed,
    docker: {
      run: async (args) => {
        calls.push({ args });
        return done(answers(args, calls.length));
      },
      pipe: async (args, out) => {
        calls.push({ args });
        const r = answers(args, calls.length);
        if ((r.code ?? 0) === 0 && piped) out.end(piped);
        else out.end();
        await new Promise((res) => out.once('finish', res).once('close', res));
        return done(r);
      },
      feed: async (args, write) => {
        calls.push({ args });
        const sink = new Sink();
        fed.push(sink);
        const writeError = await write(sink).then(
          () => undefined,
          (e: unknown) => e,
        );
        return { ...done(answers(args, calls.length)), ...(writeError ? { writeError } : {}) };
      },
    },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'retake-share-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('load: the fresh tar to docker load, its answer and the tags of this machine checked', () => {
  const lsTags = (args: string[]) => args[0] === 'image' && args[1] === 'ls' && args.includes('--format');
  async function file(t: Buffer): Promise<{ f: string; sha256: string }> {
    const f = join(dir, `x-${Math.random()}.tar.gz`);
    const gz = gzipSync(t);
    await writeFile(f, gz);
    return { f, sha256: sha(gz) };
  }

  it('refuses a hostile tar before docker load is started', async () => {
    const img = image({ extra: [entry('x/../manifest.json', json([{ Config: 'x', RepoTags: ['postgres:17'] }]))] });
    const { f, sha256 } = await file(img.tar);
    const { docker, calls } = fakeDocker(() => ({}));
    await expect(createSandboxShare({ docker: () => docker }).load(f, { expect: [img.id], sha256, maxBytes: 1 << 30, policy: PERSON_POLICY })).rejects.toThrow(
      /refused, nothing loaded: a name that is not clean/,
    );
    expect(calls).toEqual([]);
  });

  it("loads Retake's tar; another id loaded is removed (only when new here); a moved tag is put back, a new one removed", async () => {
    const img = image();
    const { f, sha256 } = await file(img.tar);
    const ok = fakeDocker((args) => (args[0] === 'load' ? { stdout: `Loaded image ID: ${img.id}\n` } : lsTags(args) ? { stdout: 'postgres:17 sha256:old\n' } : {}));
    expect(await createSandboxShare({ docker: () => ok.docker }).load(f, { expect: [img.id], sha256, maxBytes: 1 << 30, policy: PERSON_POLICY })).toEqual({ loaded: [img.id] });
    const fed = readOut(ok.fed[0]!.bytes);
    expect(JSON.parse(fed.get('manifest.json')!.toString())[0].RepoTags).toBeNull();
    expect(fed.has(`blobs/sha256/${img.legacy}`)).toBe(false);
    // docker load said it loaded another image as well: the new one removed, the one here before kept.
    const third = `sha256:${'d'.repeat(64)}`;
    const extra = fakeDocker((args) =>
      args[0] === 'load' ? { stdout: `Loaded image ID: ${img.id}\nLoaded image ID: ${third}\n` } : args[1] === 'ls' && args.includes('-q') ? { stdout: `${img.id}\n` } : {},
    );
    await expect(createSandboxShare({ docker: () => extra.docker }).load(f, { expect: [img.id], sha256, maxBytes: 1 << 30, policy: PERSON_POLICY })).rejects.toThrow(
      /it loaded sha256:[0-9a-f]+, sha256:d+, not/,
    );
    expect(extra.calls.filter((c) => c.args[1] === 'rm').map((c) => c.args)).toEqual([['image', 'rm', third]]);
    // A tag of this machine moved or went (whatever docker said): put back on its old id; a tag that appeared on an
    // image this load made: removed; one that appeared on an image here before: left alone; nothing here before removed.
    const OLD = `sha256:${'0'.repeat(64)}`;
    const HERE = `sha256:${'9'.repeat(64)}`;
    let ls = 0;
    const moved = fakeDocker((args) => {
      if (args[0] === 'load') return { stdout: `Loaded image: postgres:17\nLoaded image ID: ${HERE}\n` };
      if (lsTags(args)) return ls++ === 0 ? { stdout: `postgres:17 ${OLD}\nredis:7 ${OLD}\n` } : { stdout: `postgres:17 ${img.id}\nretake-x:new ${img.id}\nmine:1 ${HERE}\n` };
      if (args[1] === 'ls' && args.includes('-q')) return { stdout: `${OLD}\n${HERE}\n` };
      return {};
    });
    await expect(createSandboxShare({ docker: () => moved.docker }).load(f, { expect: [img.id], sha256, maxBytes: 1 << 30, policy: PERSON_POLICY })).rejects.toThrow(
      /docker load refused: it named a tag \(the tags of this machine it touched: postgres:17 put back on 000000000000; redis:7 put back on 000000000000; retake-x:new removed; mine:1 appeared on 999999999999, an image here before: left alone\)/,
    );
    expect(moved.calls.filter((c) => c.args[0] === 'tag' || c.args[1] === 'rm').map((c) => c.args)).toEqual([
      ['tag', OLD, 'postgres:17'],
      ['tag', OLD, 'redis:7'],
      ['image', 'rm', '--no-prune', 'retake-x:new'],
    ]);
    // A restore that fails is said; a listing that fails before the load refuses it.
    let n2 = 0;
    const failing = fakeDocker((args) => {
      if (args[0] === 'load') return { stdout: `Loaded image ID: ${img.id}\n` };
      if (lsTags(args)) return n2++ === 0 ? { stdout: `postgres:17 ${OLD}\n` } : { stdout: `postgres:17 ${img.id}\n` };
      if (args[0] === 'tag') return { code: 1, stderr: 'Error response from daemon: denied' };
      return {};
    });
    await expect(createSandboxShare({ docker: () => failing.docker }).load(f, { expect: [img.id], sha256, maxBytes: 1 << 30, policy: PERSON_POLICY })).rejects.toThrow(
      /FAILED: postgres:17 could not be put back on 000000000000 \(Error response from daemon: denied\)/,
    );
    // The id listing failing too (an image here before would look new): no load.
    const noIds = fakeDocker((args) => (args[1] === 'ls' && args.includes('-q') ? { code: 1, stderr: 'Cannot connect to the Docker daemon' } : {}));
    await expect(createSandboxShare({ docker: () => noIds.docker }).load(f, { expect: [img.id], sha256, maxBytes: 1 << 30, policy: PERSON_POLICY })).rejects.toThrow(/docker image ls: Cannot connect/);
    expect(noIds.calls.some((c) => c.args[0] === 'load' || c.args[1] === 'rm')).toBe(false);
    const blind = fakeDocker((args) => (lsTags(args) ? { code: 1, stderr: 'Cannot connect to the Docker daemon' } : {}));
    await expect(createSandboxShare({ docker: () => blind.docker }).load(f, { expect: [img.id], sha256, maxBytes: 1 << 30, policy: PERSON_POLICY })).rejects.toThrow(/docker image ls: Cannot connect/);
    expect(blind.calls.some((c) => c.args[0] === 'load')).toBe(false);
  });

  it('says a full disk in words', async () => {
    const img = image();
    const { f, sha256 } = await file(img.tar);
    const full = fakeDocker((args) => (args[0] === 'load' ? { code: 1, stderr: 'Error processing tar file: write /var/lib/docker/tmp/x: no space left on device' } : {}));
    await expect(createSandboxShare({ docker: () => full.docker }).load(f, { expect: [img.id], sha256, maxBytes: 1 << 30, policy: PERSON_POLICY })).rejects.toThrow(
      /Docker's disk is full \(no space left on device\): free space in Docker, then load again/,
    );
  });
});

describe('save, compose, tag, docker', () => {
  it('saves by id with --platform, gzipped into a new file; a failure leaves no file', async () => {
    const raw = image().tar;
    const { docker, calls } = fakeDocker(() => ({}), raw);
    const share = createSandboxShare({ docker: () => docker });
    const f = join(dir, 'img.tar.gz');
    const progress: number[] = [];
    const r = await share.save(ID, { platform: 'linux/arm64', file: f, policy: PERSON_POLICY, onBytes: (n) => progress.push(n) });
    expect(calls[0]?.args).toEqual(['save', '--platform', 'linux/arm64', ID]);
    expect(progress.at(-1)).toBe(readFileSync(f).length);
    // Without a platform (a Docker before 25): no --platform.
    await share.save(ID, { file: join(dir, 'plain.tar.gz'), policy: PERSON_POLICY });
    expect(calls[1]?.args).toEqual(['save', ID]);
    const bytes = readFileSync(f);
    expect(gunzipSync(bytes).equals(raw)).toBe(true);
    expect(r).toEqual({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await expect(share.save(ID, { file: f, policy: PERSON_POLICY })).rejects.toThrow(/EEXIST/);
    expect(readFileSync(f).equals(bytes)).toBe(true);
    const failing = fakeDocker(() => ({ code: 1, stderr: 'Error response from daemon: no such image' }));
    const g = join(dir, 'gone.tar.gz');
    await expect(createSandboxShare({ docker: () => failing.docker }).save(ID, { file: g, policy: PERSON_POLICY })).rejects.toThrow(/no such image/);
    expect(existsSync(g)).toBe(false);
    await expect(share.save('postgres:17', { file: join(dir, 'n'), policy: PERSON_POLICY })).rejects.toThrow(/not an image id/);
  });

  it('reads the compose config: images, builds, bind mounts, env files by key names, secrets, configs, includes', async () => {
    const p = join(dir, 'projects', 'demo');
    await mkdir(join(p, 'sandbox'), { recursive: true });
    await writeFile(join(p, 'project.yaml'), 'name: Demo\nsandboxes:\n  sbx: sandbox/sandbox.yaml\n');
    await writeFile(join(p, 'sandbox', 'sandbox.yaml'), 'version: 1\nprovider: docker-compose\nservices:\n  app: {url: "http://127.0.0.1:4630", pages: {app: "http://127.0.0.1:4630"}}\n');
    await writeFile(join(p, 'sandbox', 'compose.yaml'), 'include:\n  - ../../shared/base.yaml\nservices:\n  app:\n    build: .\n    extends: {file: common.yaml, service: base}\n');
    await writeFile(join(p, 'sandbox', 'app.env'), 'TOKEN=value-never-read\nexport MODE=x\n');
    const config = {
      services: {
        app: {
          build: { context: join(p, 'sandbox') },
          volumes: [
            { type: 'bind', source: join(p, 'data'), target: '/data' },
            { type: 'volume', source: 'db', target: '/db' },
          ],
          env_file: [{ path: join(p, 'sandbox', 'app.env'), required: true }],
        },
        mail: { image: 'axllent/mailpit:v1.29.4' },
      },
      secrets: { db: { file: join(p, 'secrets', 'db.txt') } },
      configs: { nginx: { file: join(p, 'nginx.conf') } },
    };
    let opts: DockerRunOptions | undefined;
    const { docker, calls } = fakeDocker(() => ({ stdout: JSON.stringify(config) }));
    const run = docker.run;
    docker.run = (args, o) => ((opts = o), run(args, o));
    const project = await loadProject(p);
    const f = await createSandboxShare({ docker: () => docker }).compose(project, 'sbx', PERSON_POLICY);
    expect(calls[0]?.args.slice(-3)).toEqual(['config', '--format', 'json']);
    // From the compose folder (never the caller's cwd).
    expect(opts?.cwd).toBe(join(realpathSync(p), 'sandbox'));
    expect(f.services.map((s) => [s.name, s.image, s.build ?? null])).toEqual([
      ['app', `${f.project}-app`, join(p, 'sandbox')],
      ['mail', 'axllent/mailpit:v1.29.4', null],
    ]);
    expect(f.services[0]?.binds).toEqual([{ source: join(p, 'data'), target: '/data' }]);
    expect(f.services[0]?.envFileKeys).toEqual([{ file: join(p, 'sandbox', 'app.env'), keys: ['TOKEN', 'MODE'] }]);
    expect(JSON.stringify(f)).not.toContain('value-never-read');
    expect(f.secretFiles).toEqual([join(p, 'secrets', 'db.txt')]);
    expect(f.configFiles).toEqual([join(p, 'nginx.conf')]);
    expect(f.includes).toEqual(['../../shared/base.yaml', 'common.yaml']);
  });

  it('tags an image id with a retake-… tag only; docker facts read', async () => {
    const { docker, calls } = fakeDocker((args) =>
      args[0] === 'image' && args[1] === 'inspect'
        ? args.at(-1) === 'retake-share-demo-sbx-app:taken'
          ? { stdout: `sha256:${'f'.repeat(64)}\n` }
          : { code: 1, stderr: 'No such image' }
        : args[0] === 'compose'
          ? { stdout: 'v2.29.1\n' }
          : args[0] === 'info'
            ? { stdout: args.includes('{{.ServerVersion}}') ? '29.8.2\n' : '/var/lib/docker\n' }
            : args[0] === 'version'
              ? { stdout: 'linux/arm64\n' }
              : { stdout: '  --platform string   Save only the given platform\n' },
    );
    const share = createSandboxShare({ docker: () => docker });
    await share.tag(ID, 'retake-share-demo-sbx-app:aaaaaaaaaaaa', PERSON_POLICY);
    expect(calls.at(-1)?.args).toEqual(['tag', ID, 'retake-share-demo-sbx-app:aaaaaaaaaaaa']);
    await expect(share.tag(ID, 'postgres:17', PERSON_POLICY)).rejects.toThrow(/share tag/);
    await expect(share.tag('postgres', 'retake-x:y', PERSON_POLICY)).rejects.toThrow(/share tag/);
    // A tag that names another image here is never re-pointed.
    await expect(share.tag(ID, 'retake-share-demo-sbx-app:taken', PERSON_POLICY)).rejects.toThrow(/names another image here \(ffffffffffff\): never re-pointed/);
    expect(calls.filter((c) => c.args[0] === 'tag')).toHaveLength(1);
    expect(await share.docker(PERSON_POLICY)).toEqual({ compose: '2.29.1', server: '29.8.2', platform: 'linux/arm64', root: '/var/lib/docker', savePlatform: true, store: 'classic' });
    const ctr = fakeDocker((args) =>
      args[0] === 'compose'
        ? { stdout: 'v2.29.1\n' }
        : args.includes('{{json .DriverStatus}}')
          ? { stdout: '[["driver-type","io.containerd.snapshotter.v1"]]\n' }
          : args[0] === 'info'
            ? { stdout: '29.8.2\n' }
            : {},
    );
    expect((await createSandboxShare({ docker: () => ctr.docker }).docker(PERSON_POLICY)).store).toBe('containerd');
  });
});

describe("the trust override among a sandbox's compose files", () => {
  it('comes last only when the gate hands it with the sha256 its bytes still have; a planted file is never read', async () => {
    const p = join(dir, 'projects', 'demo');
    await mkdir(join(p, 'sandbox'), { recursive: true });
    const base = { env: 'sbx', dir: join(p, 'sandbox'), manifest: { version: 1, provider: 'docker-compose', services: {} } } as unknown as Parameters<typeof composeProject>[1];
    const compose = join(realpathSync(p), 'sandbox', 'compose.yaml');
    const override = sandboxImagesOverride(p, 'sbx');
    await mkdir(dirname(override), { recursive: true });
    await writeFile(override, 'services: {app: {privileged: true}}\n');
    // Planted in the project's state, not handed by the gate: never read.
    expect(composeProject({ slug: 'demo' }, base).files).toEqual([compose]);
    const good = sha(readFileSync(override));
    // Handed with its verified text: given to docker as `-f -` on its standard input, never as the file (no swap).
    const ref = composeProject({ slug: 'demo' }, { ...base, imagesOverride: { file: override, sha256: good, text: readFileSync(override, 'utf8') } });
    expect(ref.files).toEqual([compose]);
    expect(ref.overrideText).toBe(readFileSync(override, 'utf8'));
    expect(composeArgs(ref).join(' ')).toContain(`-f ${compose} -f -`);
    expect(composeArgs(ref)).not.toContain(override);
    // A text that does not hash to what trust recorded: left out.
    const bad = composeProject({ slug: 'demo' }, { ...base, imagesOverride: { file: override, sha256: good, text: 'services: {app: {pid: host}}\n' } });
    expect(bad.overrideText).toBeUndefined();
    expect(composeArgs(bad)).not.toContain('-');
  });
});

describe('core envFileKeys', () => {
  it('reads names as a dotenv reader does: a quoted multi-line value is one value, odd names left out', () => {
    const text = 'DB_PASSWORD=x\nTLS_KEY="-----BEGIN KEY-----\nQmVyeVNlY3JldFRhaWxPZlRoZUtleQ==\n-----END KEY-----"\nexport MODE=\'a\nb=c\'\nweird.name=1\nLAST=1 # c\n';
    expect(envFileKeys(text)).toEqual(['DB_PASSWORD', 'TLS_KEY', 'MODE', 'LAST']);
  });
});

describe('core rewriteSandboxCompose', () => {
  it('rewrites only the path scalars: CRLF, flow lists, long lines, comments and quoting kept', () => {
    const long = `# ${'a long comment '.repeat(8)}`;
    const text = `${long}\r\nversion: 1\r\nprovider: docker-compose\r\ncompose:\r\n  files: [../../infra/compose.yaml, 'local.yaml']   # outside\r\n  env_file: "../../infra/.env"\r\ndescription: ${'x'.repeat(120)}\r\nservices:\r\n  app: {url: "http://x.test"}\r\n`;
    const out = rewriteSandboxCompose(text, { files: ['compose-files/compose.yaml', 'local.yaml'], envFile: 'compose-files/.env' });
    expect(out).toBe(text.replace('../../infra/compose.yaml', 'compose-files/compose.yaml').replace('"../../infra/.env"', '"compose-files/.env"'));
    expect(parseYaml(out).value).toMatchObject({ compose: { files: ['compose-files/compose.yaml', 'local.yaml'], env_file: 'compose-files/.env' } });
    // A value that cannot stay plain is double-quoted.
    expect(rewriteSandboxCompose('compose:\n  files: [a.yaml]\n', { files: ['dir with: colon.yaml'] })).toBe('compose:\n  files: ["dir with: colon.yaml"]\n');
    expect(() => rewriteSandboxCompose('- a\n', { files: [] })).toThrow(/not a mapping/);
    expect(() => rewriteSandboxCompose('compose:\n  files: [a.yaml]\n', { files: ['a', 'b'] })).toThrow(/as many files/);
  });
});
