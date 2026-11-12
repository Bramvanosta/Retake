/**
 * User media (L2.12, R-OWN-01/02/03): the scenario's and the theme's own files — normalisation into component uses,
 * ffprobe interpretation, Lottie metadata, and the positioned validation of every field (media generated locally with
 * ffmpeg; the tests that need it are skipped without ffmpeg).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MEDIA_COMPONENTS,
  isTemplateMediaRef,
  mediaFileOf,
  mediaSegmentUse,
  overlayUseOf,
  parseScenario,
  parseTemplateYaml,
  readLottieMeta,
  resolveThemeComponents,
  videoProbeFromJson,
  workPolicyFrom,
  DEFAULT_TEMPLATE,
  PERSON_POLICY,
} from '@retake/core';
import { probeVideoFile, fileFacts } from '@retake/core/io';
import type { ValidationIssue } from '@retake/core';
import { colOf, fakeProject, lineOf, tempDir } from './helpers.js';

function hasTool(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const can = hasTool('ffmpeg') && hasTool('ffprobe');
const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

/** A minimal valid bodymovin animation (one shape layer, 30 fps, 45 frames, 200 × 100). */
export const LOTTIE = JSON.stringify({
  v: '5.7.4',
  fr: 30,
  ip: 0,
  op: 45,
  w: 200,
  h: 100,
  nm: 'dot',
  ddd: 0,
  assets: [],
  layers: [{ ddd: 0, ind: 1, ty: 4, nm: 'dot', sr: 1, ks: {}, ao: 0, shapes: [], ip: 0, op: 45, st: 0, bm: 0 }],
});

const fmt = (issues: ValidationIssue[]) => issues.map((i) => `${i.severity} ${i.line}:${i.col} ${i.path.join('.')}: ${i.message}`);

describe('normalisation into component uses', () => {
  it('a segment file becomes studio/media or studio/lottie with the file in its `file` slot', () => {
    expect(mediaFileOf({ video: ' assets/intro.mp4 ' })).toEqual({ kind: 'video', path: 'assets/intro.mp4' });
    expect(mediaFileOf({ component: 'studio/intro-stack' } as never)).toBeUndefined();
    expect(mediaSegmentUse({ video: 'assets/intro.mp4', from: 1, to: 4, volume: 0.5, fit: 'contain', background: 'paper' })).toEqual({
      id: MEDIA_COMPONENTS.media,
      params: { fit: 'contain', background: 'paper', from: 1, to: 4, volume: 0.5 },
      slots: { file: 'assets/intro.mp4' },
    });
    expect(mediaSegmentUse({ image: 'assets/end.png' })).toEqual({ id: 'studio/media', params: {}, slots: { file: 'assets/end.png' } });
    // A Lottie file: from / to / volume do not apply; the spec's own params (colours) are kept.
    expect(mediaSegmentUse({ lottie: 'assets/cup.json', params: { colors: { '#ff0000': 'accent' } } })).toEqual({
      id: MEDIA_COMPONENTS.lottie,
      params: { colors: { '#ff0000': 'accent' } },
      slots: { file: 'assets/cup.json' },
    });
    expect(mediaSegmentUse({})).toBeUndefined();
  });

  it('an overlay file is contained in a box, on no background; a component overlay keeps its form', () => {
    expect(overlayUseOf({ video: 'assets/burst.webm', anchor: 'target', scale: 0.5, loop: true })).toEqual({
      component: 'studio/media',
      slots: { file: 'assets/burst.webm' },
      params: { fit: 'contain', background: 'none', loop: true },
      box: { anchor: 'target', scale: 0.5 },
    });
    expect(overlayUseOf({ lottie: 'assets/check.json', rect: { x: 10, y: 20, w: 100, h: 100 } })).toMatchObject({ component: 'studio/lottie', box: { rect: { x: 10, y: 20, w: 100, h: 100 } } });
    expect(overlayUseOf({ component: 'studio/overlay-callout', slots: { text: 'x' } })).toEqual({ component: 'studio/overlay-callout', slots: { text: 'x' }, params: {} });
    // Any overlay may be placed in a box (a box-filling workspace component).
    expect(overlayUseOf({ component: 'acme/sticker', anchor: 'top-right' }).box).toEqual({ anchor: 'top-right' });
  });

  it('a theme may fill intro, outro and interstitial with its own files (paths relative to the template folder)', () => {
    const t = { ...DEFAULT_TEMPLATE, components: { intro: { video: 'assets/intro.mp4', duration: 4 }, outro: { image: 'end.png' }, card: 'studio/card-title' } };
    expect(isTemplateMediaRef(t.components.intro)).toBe(true);
    expect(isTemplateMediaRef('studio/card-title' as never)).toBe(false);
    const c = resolveThemeComponents(t as never);
    expect(c.intro).toEqual({ id: 'studio/media', params: {}, source: 'theme', file: { kind: 'video', path: 'assets/intro.mp4' }, slots: { file: 'assets/intro.mp4' }, duration: 4 });
    expect(c.outro).toMatchObject({ id: 'studio/media', file: { kind: 'image', path: 'end.png' } });
    expect(c.card).toMatchObject({ id: 'studio/card-title', source: 'theme' });
  });
});

describe('probing', () => {
  it('reads codec, size, length, sound and alpha from ffprobe JSON', () => {
    const fmtJson = (streams: object[], duration = '2.0') => ({ streams, format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration } });
    const prores = videoProbeFromJson(fmtJson([{ codec_type: 'video', codec_name: 'prores', profile: '4444', pix_fmt: 'yuva444p12le', width: 320, height: 240, avg_frame_rate: '30/1' }]));
    expect(prores).toMatchObject({ codec: 'prores', alpha: true, audio: false, width: 320, height: 240, fps: 30, duration_s: 2 });
    const vp9 = videoProbeFromJson({
      streams: [{ codec_type: 'video', codec_name: 'vp9', pix_fmt: 'yuv420p', width: 480, height: 480, r_frame_rate: '30/1', tags: { ALPHA_MODE: '1' } }],
      format: { format_name: 'matroska,webm', duration: '1.2' },
    });
    expect(vp9).toMatchObject({ codec: 'vp9', alpha: true, container: 'matroska,webm' });
    const h264 = videoProbeFromJson(
      fmtJson([
        { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
        { codec_type: 'audio', codec_name: 'aac' },
      ]),
    );
    expect(h264).toMatchObject({ alpha: false, audio: true, fps: 29.97 });
    expect(() => videoProbeFromJson({ streams: [{ codec_type: 'audio' }] })).toThrow(/no video stream/);
  });

  it('reads a Lottie file and says what is wrong with one that is not', () => {
    expect(readLottieMeta(LOTTIE)).toEqual({ version: '5.7.4', name: 'dot', width: 200, height: 100, fps: 30, frames: 45, duration_s: 1.5, external_images: 0 });
    expect(() => readLottieMeta('{nope')).toThrow(/not a JSON file/);
    expect(() => readLottieMeta('{"a": 1}')).toThrow(/not a Lottie \(bodymovin\) animation: fr, ip, op, w, h, layers missing/);
    expect(() => readLottieMeta(JSON.stringify({ ...JSON.parse(LOTTIE), op: 0 }))).toThrow(/no frames/);
    const external = {
      ...JSON.parse(LOTTIE),
      assets: [
        { id: 'i', p: 'img_0.png', u: 'images/', e: 0 },
        { id: 'j', p: 'data:image/png;base64,AA', e: 1 },
      ],
    };
    expect(readLottieMeta(JSON.stringify(external)).external_images).toBe(1);
  });
});

describe.skipIf(!can)('validation of user files (positioned)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir('retake-media-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
    const a = (f: string) => join(dir, 'assets', f);
    // 2 s H.264 with a tone; 1 s VP9 with alpha; 1 s H.264 without alpha; an MPEG-4 Part 2 video; a PNG; a Lottie.
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x204060:s=160x90:d=2:r=30', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', a('intro.mp4')]);
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=red@0.0:s=64x64:d=1:r=30,format=rgba,geq=r=255:g=0:b=0:a=if(lt(X\\,32)\\,255\\,0)',
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuva420p',
      '-auto-alt-ref',
      '0',
      a('burst.webm'),
    ]);
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', a('opaque.mp4')]);
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1:r=30', '-c:v', 'mpeg4', a('old.mp4')]);
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=64x48', '-frames:v', '1', a('end.png')]);
    writeFileSync(a('dot.json'), LOTTIE);
    writeFileSync(a('fake.png'), 'not a png');
    writeFileSync(join(dir, 'project.yaml'), 'name: P\n');
  }, 60_000);
  afterAll(async () => cleanup?.());

  const check = (yaml: string) => parseScenario(yaml, { files: fileFacts(PERSON_POLICY), project: fakeProject(dir) }).issues;

  it('accepts the documented forms', () => {
    const text = [
      'video: own',
      'intro: {video: assets/intro.mp4, from: 0.5, to: 1.5, volume: 0.8}',
      'outro: {image: assets/end.png, duration: 3, fit: contain, background: dark}',
      'scenes:',
      '  - id: a',
      '    page: shop',
      '    open: /',
      '    steps:',
      '      - hover: {text: Save}',
      '        mark: m',
      '        overlay: {video: assets/burst.webm, at: click, anchor: target, scale: 0.5}',
      '      - hover: {text: Save}',
      '        overlay: {lottie: assets/dot.json, at: "mark:m", anchor: top-right, loop: true, duration: 3}',
      '      - hover: {text: Save}',
      '        overlay: {image: assets/end.png, rect: {x: 10, y: 10, w: 200, h: 150}, at: 0.4}',
      '  - card: {lottie: assets/dot.json, params: {colors: {"#ff5a1f": accent}}}',
      '  - interstitial: {video: assets/intro.mp4}',
    ].join('\n');
    const issues = check(text);
    expect(fmt(issues.filter((i) => i.severity !== 'warning' || !/page|first scene/.test(i.message)))).toEqual([
      // A click step is needed for at: click.
      `warning ${lineOf(text, 'at: click')}:${colOf(text, 'click,')} scenes.0.steps.0.overlay.at: a hover step has no click: the overlay starts at the end of the step`,
    ]);
  });

  it('reports every mistake where it is written', () => {
    const text = [
      'video: own',
      'intro: {video: assets/intro.mp4, from: 3, component: studio/intro-stack}',
      'outro: {image: assets/intro.mp4}',
      'scenes:',
      '  - id: a',
      '    page: shop',
      '    open: /',
      '    steps:',
      '      - click: {text: Save}',
      '        overlay: {video: assets/opaque.mp4, at: "mark:nope", volume: 0.5}',
      '      - click: {text: Save}',
      '        overlay: {lottie: assets/end.png}',
      '      - click: {text: Save}',
      '        overlay: {video: assets/missing.webm}',
      '      - click: {text: Save}',
      '        overlay: {video: assets/old.mp4, rect: {x: 0, y: 0, w: 10, h: 10}, anchor: center, scale: 2}',
      '      - click: {text: Save}',
      '        overlay: {slots: {text: x}}',
      '  - card: {video: assets/intro.mp4, from: 1.5, to: 1, slots: {title: T}}',
      '  - card: {video: assets/intro.mp4, to: 9}',
      '  - card: {image: assets/fake.png}',
      '  - card: {video: assets/clip.avi}',
      '  - interstitial: {kicker: Later}',
      '  - interstitial: {image: assets/end.png, text: Later}',
      '  - card: {lottie: assets/dot.json, volume: 0.9}',
      '  - card: {fit: cover, slots: {title: T}}',
    ].join('\n');
    const out = fmt(check(text).filter((i) => !/first scene/.test(i.message)));
    const at = (needle: string, occurrence = 1) => `${lineOf(text, needle, occurrence)}:${colOf(text, needle, occurrence)}`;
    expect(out).toEqual([
      `error ${at('3, component')} intro.from: \`from\` (3 s) is past the end of "assets/intro.mp4" (2 s)`,
      `error ${at('studio/intro-stack')} intro.component: \`component\` and \`video\` exclude each other: the file replaces the component (its \`params\` go to studio/media)`,
      `error ${at('assets/intro.mp4}')} outro.image: "assets/intro.mp4": an image must be a .png, .jpg, .jpeg, .webp, .svg file (not .mp4) — it looks like a video: write \`video:\``,
      `warning ${at('assets/opaque.mp4')} scenes.0.steps.0.overlay.video: "assets/opaque.mp4" has no alpha channel: it covers the capture inside its box — export ProRes 4444 (.mov) or VP9 with alpha (.webm) for a transparent overlay (docs/BRING-YOUR-OWN-MOTION.md)`,
      `error ${at('"mark:nope"')} scenes.0.steps.0.overlay.at: unknown mark "nope": no step has \`mark: nope\``,
      `warning ${at('0.5}')} scenes.0.steps.0.overlay.volume: "assets/opaque.mp4" has no sound: \`volume\` changes nothing`,
      `error ${at('assets/end.png}')} scenes.0.steps.1.overlay.lottie: "assets/end.png": a Lottie file must be a .json file (not .png) — it looks like an image: write \`image:\``,
      `error ${at('assets/missing.webm')} scenes.0.steps.2.overlay.video: video file "assets/missing.webm" not found in the project`,
      `error ${at('assets/old.mp4')} scenes.0.steps.3.overlay.video: "assets/old.mp4": the video codec "mpeg4" is not supported — use H.264, HEVC (H.265), VP8, VP9, AV1, ProRes (e.g. ffmpeg -i in -c:v libx264 -pix_fmt yuv420p out.mp4; see docs/BRING-YOUR-OWN-MOTION.md)`,
      `warning ${at('assets/old.mp4')} scenes.0.steps.3.overlay.video: "assets/old.mp4" has no alpha channel: it covers the capture inside its box — export ProRes 4444 (.mov) or VP9 with alpha (.webm) for a transparent overlay (docs/BRING-YOUR-OWN-MOTION.md)`,
      `warning ${at('center')} scenes.0.steps.3.overlay.anchor: \`rect\` places the overlay: \`anchor\` is ignored`,
      `warning ${at('2}')} scenes.0.steps.3.overlay.scale: \`scale\` is ignored: \`rect\` sets the size`,
      `error ${at('{slots: {text: x}}')} scenes.0.steps.4.overlay: an overlay needs a \`component\` or a \`video\` / \`image\` / \`lottie\` file`,
      `error ${at('1, slots')} scenes.1.card.to: \`to\` (1 s) must be after \`from\` (1.5 s)`,
      `warning ${at('{title: T}}')} scenes.1.card.slots: the video file replaces the card component: slots title are not shown`,
      `error ${at('9}')} scenes.2.card.to: \`to\` (9 s) is past the end of "assets/intro.mp4" (2 s)`,
      `error ${at('assets/fake.png')} scenes.3.card.image: "assets/fake.png" is not a PNG image (its content does not match its extension)`,
      `error ${at('assets/clip.avi')} scenes.4.card.video: "assets/clip.avi": a video must be a .mp4, .m4v, .mov, .webm file (not .avi) — convert it with ffmpeg (see docs/BRING-YOUR-OWN-MOTION.md)`,
      `error ${at('{kicker: Later}')} scenes.5.interstitial: an interstitial needs \`text\` (or a \`video\` / \`image\` / \`lottie\` file)`,
      `warning ${at('Later}', 2)} scenes.6.interstitial.text: the image file replaces the interstitial component: \`text\` is not shown`,
      `error ${at('0.9}')} scenes.7.card.volume: \`volume\` applies to a video (this is a Lottie file)`,
      `error ${at('cover')} scenes.8.card.fit: \`fit\` applies to a file (\`video:\`, \`image:\` or \`lottie:\`)`,
    ]);
  });

  it('probes once per file version (cache) and says when a file is not a video', () => {
    const p = probeVideoFile(join(dir, 'assets', 'intro.mp4'), PERSON_POLICY);
    expect(p).toMatchObject({ codec: 'h264', width: 160, height: 90, audio: true, alpha: false });
    expect(p.duration_s).toBeCloseTo(2, 1);
    expect(probeVideoFile(join(dir, 'assets', 'intro.mp4'), PERSON_POLICY)).toBe(p);
    expect(probeVideoFile(join(dir, 'assets', 'burst.webm'), PERSON_POLICY)).toMatchObject({ codec: 'vp9', alpha: true });
    expect(() => probeVideoFile(join(dir, 'assets', 'dot.json'), PERSON_POLICY)).toThrow(/ffprobe cannot read it|no video stream/);
  });

  it('the cache is per ffprobe: another ffprobe reads the same file again (its answer is its own)', () => {
    const file = join(dir, 'assets', 'opaque.mp4');
    expect(probeVideoFile(file, PERSON_POLICY)).toMatchObject({ codec: 'h264' });
    const broken = join(dir, 'broken-ffprobe');
    writeFileSync(broken, '#!/bin/sh\necho "this ffprobe reads nothing" >&2\nexit 3\n', { mode: 0o755 });
    const saved = process.env.RETAKE_FFPROBE;
    process.env.RETAKE_FFPROBE = broken;
    try {
      expect(() => probeVideoFile(file, PERSON_POLICY)).toThrow('ffprobe cannot read it (this ffprobe reads nothing)');
    } finally {
      if (saved === undefined) delete process.env.RETAKE_FFPROBE;
      else process.env.RETAKE_FFPROBE = saved;
    }
    expect(probeVideoFile(file, PERSON_POLICY)).toMatchObject({ codec: 'h264' });
  });

  it("a work's ffprobe its policy refuses: the video is reported as one the renderer cannot read, in the refusal's words", () => {
    const inside = join(dir, 'bin', 'ffprobe');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(inside, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const saved = process.env.RETAKE_FFPROBE;
    process.env.RETAKE_FFPROBE = inside;
    try {
      const issues = parseScenario('video: own\nintro: {video: assets/intro.mp4}\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - hover: {text: Save}\n', {
        files: fileFacts(workPolicyFrom([dir])),
        project: fakeProject(dir),
      }).issues;
      expect(issues.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([
        expect.stringMatching(/^"assets\/intro\.mp4" is not a video the renderer can read: \$RETAKE_FFPROBE \(.*\/bin\/ffprobe\) lies inside the workspace /),
      ]);
      // Under the person's policy the same ffprobe runs.
      expect(() => probeVideoFile(join(dir, 'assets', 'intro.mp4'), PERSON_POLICY)).toThrow(/ffprobe output not understood|ffprobe cannot read it/);
    } finally {
      if (saved === undefined) delete process.env.RETAKE_FFPROBE;
      else process.env.RETAKE_FFPROBE = saved;
    }
  });

  it("checks a theme's own files against the template folder", () => {
    const tdir = join(dir, 'theme');
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, 'intro.mp4'), '');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=64x36:d=1:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(tdir, 'intro.mp4')]);
    const text = ['components:', '  intro: {video: intro.mp4, from: 4}', '  outro: {image: missing.png}', '  interstitial: studio/interstitial-plain'].join('\n');
    const { issues } = parseTemplateYaml(text, { files: fileFacts(PERSON_POLICY), dir: tdir });
    expect(fmt(issues)).toEqual([
      `error 2:${colOf(text, '4}')} components.intro.from: \`from\` (4 s) is past the end of "intro.mp4" (1 s)`,
      `error 3:${colOf(text, 'missing.png')} components.outro.image: image file "missing.png" not found in the template folder`,
    ]);
    // Without the folder (text only), only the forms are checked.
    expect(parseTemplateYaml(text).issues).toEqual([]);
  });
});
