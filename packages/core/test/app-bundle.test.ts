/**
 * L5.16a — the app bundle resolver (core bundle.ts): manifest discovery and checks, the ffmpeg / ffprobe order, the
 * write guard, prepareBundle's browsers path that never leaks into the person's processes, and the H.264 fallback.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  BundleError,
  ConfigError,
  bundleProblems,
  H264EncoderError,
  assertOutsideBundle,
  findBundle,
  h264CodecArgs,
  h264Encoder,
  insideBundle,
  loadProject,
  loadWorkspaceConfig,
  mediaTools,
  overrideBundleInfo,
  parseEncoders,
  pickH264,
  prepareBundle,
  readBundleManifest,
  resetFfmpegEncoders,
  resolveMediaTools,
  retakeHome,
  starterTemplatesDir,
  useWorkspaceFfmpeg,
} from '@retake/core';
import type { BundleInfo } from '@retake/core';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-app-bundle-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  overrideBundleInfo(undefined);
  useWorkspaceFfmpeg(undefined);
});

let n = 0;
/** A fake bundle: <root>/bundle.json + the folders it names (+ an engine module file to discover it from). */
function fakeBundle(opts: { paths?: Record<string, unknown>; app?: boolean } = {}): { root: string; module: string } {
  const base = join(tmp, `b${n++}`);
  const root = opts.app ? join(base, 'Retake.app', 'Contents', 'Resources') : base;
  for (const d of ['node/bin', 'engine/node_modules/@retake/core/dist', 'browsers', 'ffmpeg/bin', 'engine/templates', 'plugin']) mkdirSync(join(root, d), { recursive: true });
  const module = join(root, 'engine/node_modules/@retake/core/dist/bundle.js');
  writeFileSync(module, '');
  const paths = { node: 'node/bin/node', engine: 'engine', browsers: 'browsers', ffmpeg: 'ffmpeg/bin', templates: 'engine/templates', plugin: 'plugin', ...opts.paths };
  writeFileSync(join(root, 'bundle.json'), JSON.stringify({ v: 1, app: '0.2.0', node: '22.16.0', playwright: { core: '1.56.1', chromium: '1194', headless_shell: '1194' }, compositor: '4.0.534', ffmpeg: null, minimum_macos: '15.0', paths }));
  return { root, module };
}

describe('bundle discovery and the manifest', () => {
  it('finds the bundle whose engine holds the module; none in the repository', () => {
    const b = fakeBundle();
    const info = findBundle(b.module);
    expect(info?.root).toBe(b.root);
    expect(info?.sealed).toBe(b.root);
    expect(info?.paths.browsers).toBe(join(b.root, 'browsers'));
    expect(findBundle(join(REPO, 'packages', 'core', 'src', 'bundle.ts'))).toBeNull();
  });

  it('inside Retake.app the sealed root is the whole .app', () => {
    const b = fakeBundle({ app: true });
    const info = findBundle(b.module)!;
    expect(info.sealed).toBe(resolve(b.root, '..', '..'));
    expect(insideBundle(join(info.sealed, 'Contents', 'MacOS', 'x'), info)).toBe(true);
  });

  it('a stray bundle.json whose engine is elsewhere is ignored', () => {
    const b = fakeBundle({ paths: { engine: 'browsers' } });
    expect(findBundle(b.module)).toBeNull();
  });

  it('only the one folder five above core/dist is looked at (never a walk up past the app): a manifest higher or lower is ignored', () => {
    // A manifest one folder above the stage that claims the same engine (paths.engine = <stage>/engine).
    const b = fakeBundle();
    const outer = resolve(b.root, '..');
    rmSync(join(b.root, 'bundle.json'));
    const rel = (p: string) => p.slice(outer.length + 1);
    writeFileSync(join(outer, 'bundle.json'), JSON.stringify({ v: 1, paths: { node: rel(join(b.root, 'node/bin/node')), engine: rel(join(b.root, 'engine')), browsers: rel(join(b.root, 'browsers')), ffmpeg: null, templates: rel(join(b.root, 'engine/templates')), plugin: rel(join(b.root, 'plugin')) } }));
    expect(findBundle(b.module)).toBeNull();
    // A manifest at the right depth whose engine holds the module somewhere else than node_modules/@retake/core.
    const c = fakeBundle();
    const odd = join(c.root, 'engine', 'lib', 'core', 'dist', 'x', 'bundle.js');
    mkdirSync(dirname(odd), { recursive: true });
    writeFileSync(odd, '');
    expect(findBundle(odd)).toBeNull();
    expect(findBundle(c.module)?.root).toBe(c.root);
  });

  it("a damaged manifest never throws at core's import: prepareBundle and the starter themes go on, bundleProblems names it, bundleInfo throws it", () => {
    // core's built bundle.js (pnpm build; it imports nothing but node:) copied into a fake stage whose manifest is broken.
    const b = fakeBundle({ paths: { ffmpeg: '../../ffmpeg' } });
    copyFileSync(join(REPO, 'packages', 'core', 'dist', 'bundle.js'), b.module);
    writeFileSync(join(b.root, 'engine', 'package.json'), '{"type":"module"}');
    const script = join(tmp, `damaged${n++}.mjs`);
    writeFileSync(
      script,
      `const m = await import(${JSON.stringify(b.module)});
m.prepareBundle();
const templates = m.starterTemplatesDir();
let threw = null;
try { m.bundleInfo(); } catch (e) { threw = e.name; }
console.log(JSON.stringify({ problems: m.bundleProblems(), threw, templates, env: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null }));
`,
    );
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmp } });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { problems: string[]; threw: string | null; templates: string; env: string | null };
    expect(out.problems).toEqual([expect.stringMatching(/paths\.ffmpeg \(\.\.\/\.\.\/ffmpeg\) leaves the bundle/)]);
    expect(out.threw).toBe('BundleError');
    expect(out.env).toBeNull();
  });

  it('a playwright-core that does not load with the bundle is remembered for doctor (never only swallowed)', () => {
    overrideBundleInfo(undefined);
    const bundle = readBundleManifest(fakeBundle().root);
    writeFileSync(join(bundle.root, 'node', 'guard.cjs'), '');
    prepareBundle({}, bundle, () => {
      throw new Error('Cannot find module playwright-core');
    });
    expect(bundleProblems()).toEqual([expect.stringMatching(/playwright-core does not load \(Cannot find module playwright-core\).*reinstall Retake/)]);
  });

  it("prepareBundle loads the bundle's module lookup guard before playwright-core (a process started without --require: review A H1); a missing guard is remembered for doctor", () => {
    overrideBundleInfo(undefined);
    const bundle = readBundleManifest(fakeBundle().root);
    const order: string[] = [];
    writeFileSync(join(bundle.root, 'node', 'guard.cjs'), '');
    prepareBundle({}, bundle, () => order.push('playwright-core'), (f) => order.push(f));
    expect(order).toEqual([join(bundle.root, 'node', 'guard.cjs'), 'playwright-core']);
    expect(bundleProblems()).toEqual([]);
    rmSync(join(bundle.root, 'node', 'guard.cjs'));
    prepareBundle({}, bundle, () => order.push('playwright-core'), (f) => order.push(f));
    expect(order.slice(2)).toEqual(['playwright-core']);
    expect(bundleProblems()).toEqual([expect.stringMatching(/module lookup guard does not load \(.*node\/guard\.cjs is missing\): reinstall Retake/)]);
  });

  // The bundle's own containment copy (`within`: pathInside's lexical check, options `{}`), through its caller: the
  // folder itself and a name beginning with `..` are inside, a `..` segment leads out.
  it('the manifest check: the bundle folder itself and a `..cache` name are inside, `../x` and `a/../../x` are not', () => {
    const own = fakeBundle({ paths: { plugin: '.' } });
    expect(readBundleManifest(own.root).paths.plugin).toBe(realpathSync(own.root));
    const dotted = fakeBundle({ paths: { plugin: '..cache' } });
    expect(readBundleManifest(dotted.root).paths.plugin).toBe(join(realpathSync(dotted.root), '..cache'));
    expect(() => readBundleManifest(fakeBundle({ paths: { plugin: '../x' } }).root)).toThrow(/paths\.plugin \(\.\.\/x\) leaves the bundle/);
    expect(() => readBundleManifest(fakeBundle({ paths: { plugin: 'a/../../x' } }).root)).toThrow(/leaves the bundle/);
    expect(() => readBundleManifest(fakeBundle({ paths: { plugin: '..' } }).root)).toThrow(/leaves the bundle/);
  });

  it('paths leaving the bundle are refused (.., absolute, a link out)', () => {
    expect(() => readBundleManifest(fakeBundle({ paths: { browsers: '../elsewhere' } }).root)).toThrow(/leaves the bundle/);
    expect(() => readBundleManifest(fakeBundle({ paths: { browsers: '/opt/browsers' } }).root)).toThrow(BundleError);
    const b = fakeBundle({ paths: { plugin: 'out' } });
    symlinkSync(tmp, join(b.root, 'out'));
    expect(() => readBundleManifest(b.root)).toThrow(/paths\.plugin \(out\) leaves the bundle/);
    // a broken manifest that claims this engine stops the walk with its error (a damaged app says so)
    const c = fakeBundle({ paths: { ffmpeg: '../../ffmpeg' } });
    expect(() => findBundle(c.module)).toThrow(/leaves the bundle/);
  });
});

describe('ffmpeg / ffprobe: explicit config → explicit env → bundled → system (D4)', () => {
  const bundle = readBundleManifest(fakeBundle().root);
  const noFfmpeg: BundleInfo = { ...bundle, paths: { ...bundle.paths, ffmpeg: null } };
  const env = { RETAKE_FFMPEG: '/env/bin/ffmpeg' };

  const all = () => true;

  it('each branch, in order', () => {
    expect(resolveMediaTools({ configured: '/cfg/bin/ffmpeg', env, bundle, exists: all })).toEqual({ ffmpeg: '/cfg/bin/ffmpeg', ffprobe: '/cfg/bin/ffprobe', ffmpegSource: 'retake.yaml', ffprobeSource: 'retake.yaml' });
    expect(resolveMediaTools({ env, bundle, exists: all })).toEqual({ ffmpeg: '/env/bin/ffmpeg', ffprobe: '/env/bin/ffprobe', ffmpegSource: 'RETAKE_FFMPEG', ffprobeSource: 'RETAKE_FFMPEG' });
    expect(resolveMediaTools({ env: {}, bundle })).toEqual({ ffmpeg: join(bundle.root, 'ffmpeg/bin/ffmpeg'), ffprobe: join(bundle.root, 'ffmpeg/bin/ffprobe'), ffmpegSource: 'bundled', ffprobeSource: 'bundled' });
    expect(resolveMediaTools({ env: {}, bundle: null })).toEqual({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ffmpegSource: 'PATH', ffprobeSource: 'PATH' });
    // a bundle without its own ffmpeg (ffmpeg: null) uses the system's
    expect(resolveMediaTools({ env: {}, bundle: noFfmpeg }).ffmpegSource).toBe('PATH');
  });

  it('ffprobe: $RETAKE_FFPROBE wins over the folder of $RETAKE_FFMPEG, and alone over the bundle', () => {
    expect(resolveMediaTools({ env: { ...env, RETAKE_FFPROBE: '/p/ffprobe' }, bundle, exists: all }).ffprobe).toBe('/p/ffprobe');
    expect(resolveMediaTools({ env: { RETAKE_FFPROBE: '/p/ffprobe' }, bundle })).toMatchObject({ ffmpegSource: 'bundled', ffprobe: '/p/ffprobe', ffprobeSource: 'RETAKE_FFPROBE' });
  });

  it("ffprobe beside retake.yaml's (or $RETAKE_FFMPEG's) ffmpeg only when it is there; else the normal order (a lone static ffmpeg keeps the old ffprobe)", () => {
    const none = () => false;
    expect(resolveMediaTools({ configured: '/cfg/bin/ffmpeg', env: { RETAKE_FFPROBE: '/p/ffprobe' }, bundle, exists: none })).toMatchObject({ ffmpeg: '/cfg/bin/ffmpeg', ffprobe: '/p/ffprobe', ffprobeSource: 'RETAKE_FFPROBE' });
    expect(resolveMediaTools({ configured: '/cfg/bin/ffmpeg', env: {}, bundle, exists: none })).toMatchObject({ ffprobe: join(bundle.root, 'ffmpeg/bin/ffprobe'), ffprobeSource: 'bundled' });
    expect(resolveMediaTools({ configured: '/cfg/bin/ffmpeg', env: {}, bundle: null, exists: none })).toMatchObject({ ffprobe: 'ffprobe', ffprobeSource: 'PATH' });
    expect(resolveMediaTools({ env, bundle: null, exists: none })).toMatchObject({ ffmpeg: '/env/bin/ffmpeg', ffprobe: 'ffprobe', ffprobeSource: 'PATH' });
    // a command name in retake.yaml (no folder): ffprobe is not looked for "beside" it
    expect(resolveMediaTools({ configured: 'ffmpeg7', env: {}, bundle: null, exists: all })).toMatchObject({ ffmpeg: 'ffmpeg7', ffprobe: 'ffprobe', ffprobeSource: 'PATH' });
  });

  it('a relative $RETAKE_FFMPEG / $RETAKE_FFPROBE is refused (it would name another file in each process); a command name is not', () => {
    expect(() => resolveMediaTools({ env: { RETAKE_FFMPEG: 'tools/ffmpeg' }, bundle })).toThrow(/\$RETAKE_FFMPEG \(tools\/ffmpeg\) must be an absolute path/);
    expect(() => resolveMediaTools({ env: { RETAKE_FFPROBE: './ffprobe' }, bundle })).toThrow(BundleError);
    expect(resolveMediaTools({ env: { RETAKE_FFMPEG: 'ffmpeg7' }, bundle }).ffmpeg).toBe('ffmpeg7');
  });

  it("the process's tools: the open workspace's setting, then the environment and the bundle", () => {
    overrideBundleInfo(bundle);
    expect(mediaTools().ffmpegSource).toBe(process.env.RETAKE_FFMPEG ? 'RETAKE_FFMPEG' : 'bundled');
    const dir = join(tmp, `wsff${n++}`);
    mkdirSync(dir);
    for (const t of ['ffmpeg', 'ffprobe']) writeFileSync(join(dir, t), '');
    useWorkspaceFfmpeg(join(dir, 'ffmpeg'));
    expect(mediaTools()).toMatchObject({ ffmpeg: join(dir, 'ffmpeg'), ffprobe: join(dir, 'ffprobe'), ffmpegSource: 'retake.yaml', ffprobeSource: 'retake.yaml' });
  });

  it("retake.yaml's ffmpeg: a path is the workspace's (made absolute against its root, whatever the cwd); a command name stays one", async () => {
    const root = join(tmp, `wsrel${n++}`);
    mkdirSync(root);
    writeFileSync(join(root, 'retake.yaml'), 'ffmpeg: tools/ffmpeg\n');
    expect((await loadWorkspaceConfig(root)).ffmpeg).toBe(join(root, 'tools', 'ffmpeg'));
    writeFileSync(join(root, 'retake.yaml'), 'ffmpeg: ffmpeg7\n');
    expect((await loadWorkspaceConfig(root)).ffmpeg).toBe('ffmpeg7');
  });

  it('starter themes: the bundle’s, else the repository’s templates/', () => {
    expect(starterTemplatesDir(bundle)).toBe(join(bundle.root, 'engine/templates'));
    expect(starterTemplatesDir(null)).toBe(join(REPO, 'templates'));
  });
});

describe('nothing writes inside the bundle (M3)', () => {
  it('assertOutsideBundle refuses a path inside (even one not created yet), allows one outside', () => {
    const bundle = readBundleManifest(fakeBundle().root);
    expect(() => assertOutsideBundle(join(bundle.paths.engine, 'node_modules/@retake/components/library/x/preview.png'), 'the preview of x', bundle)).toThrow(/refused: the preview of x .* inside the Retake app/);
    expect(() => assertOutsideBundle(join(tmp, 'ws'), 'the workspace', bundle)).not.toThrow();
    expect(() => assertOutsideBundle(join(bundle.root, 'x'), 'w', null)).not.toThrow();
  });

  it('a workspace (or one of its folders) inside the bundle is refused', async () => {
    const bundle = readBundleManifest(fakeBundle().root);
    overrideBundleInfo(bundle);
    const inside = join(bundle.root, 'ws');
    mkdirSync(inside);
    await expect(loadWorkspaceConfig(inside)).rejects.toThrow(/the workspace .* lies inside the Retake app/);
    const outside = join(tmp, `ws${n++}`);
    mkdirSync(outside);
    writeFileSync(join(outside, 'retake.yaml'), `components_dir: ${join(bundle.paths.engine, 'components')}\n`);
    await expect(loadWorkspaceConfig(outside)).rejects.toThrow(ConfigError);
    for (const key of ['projects_dir', 'templates_dir']) {
      writeFileSync(join(outside, 'retake.yaml'), `${key}: ${join(bundle.paths.engine, 'x')}\n`);
      await expect(loadWorkspaceConfig(outside), key).rejects.toThrow(new RegExp(`${key} .* lies inside the Retake app`));
    }
    overrideBundleInfo(null);
    await expect(loadWorkspaceConfig(inside)).resolves.toMatchObject({ root: inside });
  });

  it('a project folder linked into the bundle, and a $RETAKE_HOME inside it, are refused', async () => {
    const bundle = readBundleManifest(fakeBundle().root);
    overrideBundleInfo(bundle);
    const ws = join(tmp, `wsp${n++}`);
    mkdirSync(join(ws, 'projects'), { recursive: true });
    const sealedProject = join(bundle.root, 'p');
    mkdirSync(join(sealedProject, 'scenarios'), { recursive: true });
    writeFileSync(join(sealedProject, 'project.yaml'), 'name: P\nenvironments:\n  prod: {app: "https://app.example.com"}\n');
    symlinkSync(sealedProject, join(ws, 'projects', 'p'));
    await expect(loadProject('p', ws)).rejects.toThrow(/the project .* lies inside the Retake app/);
    expect(() => retakeHome({ RETAKE_HOME: join(bundle.root, 'home') })).toThrow(/refused: \$RETAKE_HOME .* inside the Retake app/);
    expect(retakeHome({ RETAKE_HOME: join(tmp, 'home') })).toBe(join(tmp, 'home'));
    overrideBundleInfo(null);
    await expect(loadProject('p', ws)).resolves.toMatchObject({ slug: 'p' });
  });
});

describe('prepareBundle: the browsers path for playwright-core only (M2)', () => {
  const bundle = readBundleManifest(fakeBundle().root);

  it('set while playwright-core loads, then the inherited value is back (absent or set)', () => {
    const env: NodeJS.ProcessEnv = {};
    let during: string | undefined;
    prepareBundle(env, bundle, () => (during = env.PLAYWRIGHT_BROWSERS_PATH));
    expect(during).toBe(bundle.paths.browsers);
    expect('PLAYWRIGHT_BROWSERS_PATH' in env).toBe(false);
    const mine = { PLAYWRIGHT_BROWSERS_PATH: '/my/browsers' };
    prepareBundle(mine, bundle, () => {
      throw new Error('a load error is not fatal');
    });
    expect(mine.PLAYWRIGHT_BROWSERS_PATH).toBe('/my/browsers');
    let called = false;
    prepareBundle(env, null, () => (called = true));
    expect(called).toBe(false);
  });

  it("real playwright-core keeps the bundle's browsers; the process's children never see the variable", () => {
    // A fake stage whose engine links the repository's playwright-core and holds core's built bundle.js (pnpm build).
    const b = fakeBundle();
    const pw = realpathSync(join(REPO, 'packages', 'runner-web', 'node_modules', 'playwright-core'));
    symlinkSync(pw, join(b.root, 'engine', 'node_modules', 'playwright-core'));
    const script = join(tmp, `probe${n++}.mjs`);
    writeFileSync(
      script,
      `import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { prepareBundle, readBundleManifest } from ${JSON.stringify(join(REPO, 'packages', 'core', 'dist', 'bundle.js'))};
const b = readBundleManifest(${JSON.stringify(b.root)});
prepareBundle(process.env, b);
const { chromium } = createRequire(${JSON.stringify(join(b.root, 'engine', 'package.json'))})('playwright-core');
const child = spawnSync('/usr/bin/env', { encoding: 'utf8' }).stdout;
console.log(JSON.stringify({ exe: chromium.executablePath(), env: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null, child: child.split('\\n').filter((l) => l.startsWith('PLAYWRIGHT_BROWSERS_PATH=')) }));
`,
    );
    for (const inherited of [undefined, '/person/ms-playwright']) {
      const env = { PATH: '/usr/bin:/bin', HOME: tmp, ...(inherited ? { PLAYWRIGHT_BROWSERS_PATH: inherited } : {}) };
      const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as { exe: string; env: string | null; child: string[] };
      expect(out.exe.startsWith(join(b.root, 'browsers', 'chromium-'))).toBe(true);
      expect(out.env).toBe(inherited ?? null);
      expect(out.child).toEqual(inherited ? [`PLAYWRIGHT_BROWSERS_PATH=${inherited}`] : []);
    }
  });
});

describe('the H.264 encoder: libx264, else VideoToolbox (an ffmpeg without libx264)', () => {
  const ENCODERS = (extra: string) => `Encoders:
 V..... = Video
 ------
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 V....D prores_ks            Apple ProRes (iCodec Pro) (codec prores)
${extra} A....D aac                  AAC (Advanced Audio Coding)
`;

  it('parses `ffmpeg -encoders` and picks', () => {
    const withX = parseEncoders(ENCODERS(' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)\n'));
    expect([...withX]).toEqual(['h264_videotoolbox', 'prores_ks', 'libx264', 'aac']);
    expect(pickH264(withX)).toBe('libx264');
    expect(pickH264(parseEncoders(ENCODERS('')))).toBe('h264_videotoolbox');
    expect(pickH264(new Set(['aac']))).toBeNull();
    expect(h264CodecArgs('libx264', ['-c:v', 'libx264', '-crf', '18'])).toEqual(['-c:v', 'libx264', '-crf', '18']);
    expect(h264CodecArgs('h264_videotoolbox', ['-c:v', 'libx264', '-crf', '18'])).toEqual(['-c:v', 'h264_videotoolbox', '-q:v', '85', '-profile:v', 'high']);
  });

  it('asks the ffmpeg once per path; never libx264 when it lacks it', async () => {
    resetFfmpegEncoders();
    const fake = (name: string, body: string) => {
      const f = join(tmp, name);
      writeFileSync(f, `#!/bin/sh\n${body}\n`);
      chmodSync(f, 0o755);
      return f;
    };
    expect(await h264Encoder(fake('ff-vt', `cat <<'EOF'\n${ENCODERS('')}EOF`))).toBe('h264_videotoolbox');
    expect(await h264Encoder(fake('ff-x', `cat <<'EOF'\n${ENCODERS(' V....D libx264              libx264 H.264\n')}EOF`))).toBe('libx264');
    await expect(h264Encoder(fake('ff-none', "printf 'Encoders:\\n ------\\n A....D aac   AAC\\n'"))).rejects.toThrow(H264EncoderError);
    // an ffmpeg that cannot list its encoders: today's arguments (its own error on the encode)
    expect(await h264Encoder(fake('ff-broken', 'exit 1'))).toBe('libx264');
  });
});
