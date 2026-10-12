#!/usr/bin/env node
/**
 * Regenerates the user media of the fixture (L2.12, "bring your own motion") — committed, each file < 1 MB:
 *   projects/northfield-fixture/assets/intro.mp4         intro video (Remotion render + a chime made with ffmpeg)
 *   projects/northfield-fixture/assets/end-card.png      outro image (Remotion still)
 *   projects/northfield-fixture/assets/sparkle-burst.webm alpha overlay (Remotion, transparent → VP9 + alpha)
 *   projects/northfield-fixture/assets/cup-steam.json    Lottie card (hand-written bodymovin, fixtures/own-media/lottie.mjs)
 *   projects/northfield-fixture/assets/check-badge.json  Lottie overlay
 *   packages/components/preview/media-sample.png, lottie-sample.json (+ samples.json `media.image` / `media.lottie`):
 *     the samples of the studio/media and studio/lottie previews.
 * With `--prores` it also writes projects/northfield-fixture/.demo-studio/sparkle-burst.mov (ProRes 4444 with alpha; ≈ 3.5 MB,
 * git-ignored) — the same burst for trying the ProRes path.
 *
 * The Remotion project is fixtures/own-media/src/index.tsx — a stand-in for the user's own motion design (any tool, or
 * the output of a Claude motion / design skill). Usage: node scripts/fixture-media.mjs [--prores]
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBadge, cupSteam } from '../fixtures/own-media/lottie.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'projects', 'northfield-fixture', 'assets');
const PREVIEW = join(ROOT, 'packages', 'components', 'preview');
const require = createRequire(join(ROOT, 'packages', 'editor', 'package.json'));
const { bundle } = await import(require.resolve('@remotion/bundler'));
const { renderMedia, renderStill, selectComposition } = await import(require.resolve('@remotion/renderer'));
const { renderBrowser } = await import(join(ROOT, 'packages', 'editor', 'dist', 'render', 'browser.js'));

const prores = process.argv.includes('--prores');
const browserExecutable = renderBrowser().path ?? undefined;
const tmp = await mkdtemp(join(tmpdir(), 'ds-own-media-'));
const ffmpeg = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const kb = async (f) => `${Math.round((await stat(f)).size / 1024)} KB`;

try {
  const serveUrl = await bundle({ entryPoint: join(ROOT, 'fixtures', 'own-media', 'src', 'index.tsx'), publicDir: join(ROOT, 'templates', 'editorial', 'fonts'), outDir: join(tmp, 'bundle') });
  const comp = (id) => selectComposition({ serveUrl, id, inputProps: {}, browserExecutable });

  // Intro: the video, then a chime (three soft bell tones and a pad, 10 ms attacks: no clicks) muxed in.
  const intro = await comp('intro');
  const silent = join(tmp, 'intro-silent.mp4');
  await renderMedia({ serveUrl, composition: intro, codec: 'h264', crf: 26, outputLocation: silent, browserExecutable, muted: true });
  const d = intro.durationInFrames / intro.fps;
  const tone = (f, at, k, a) => `${a}*sin(2*PI*${f}*t)*exp(-${k}*max(0,t-${at}))*min(1,max(0,t-${at})/0.01)`;
  const e = `${tone(659.25, 0.35, 2.2, 0.26)}+${tone(987.77, 0.6, 2.4, 0.2)}+${tone(1318.51, 0.85, 2.8, 0.14)}+0.06*sin(2*PI*329.63*t)*min(1,t/0.5)*min(1,(${d}-t)/0.4)`;
  ffmpeg(['-i', silent, '-f', 'lavfi', '-i', `aevalsrc=exprs='${e}|${e}':s=48000:d=${d}`, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', join(ASSETS, 'intro.mp4')]);
  console.log(`intro.mp4 ${await kb(join(ASSETS, 'intro.mp4'))}`);

  // Outro end card and the studio/media preview sample: stills, palette-quantised.
  for (const [id, out] of [
    ['end-card', join(ASSETS, 'end-card.png')],
    ['media-sample', join(PREVIEW, 'media-sample.png')],
  ]) {
    const raw = join(tmp, `${id}.png`);
    await renderStill({ serveUrl, composition: await comp(id), output: raw, browserExecutable });
    ffmpeg(['-i', raw, '-vf', 'split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=sierra2_4a', out]);
    console.log(`${id} ${await kb(out)}`);
  }

  // Alpha overlay: transparent background → VP9 with alpha (.webm); ProRes 4444 (.mov) on request.
  const burst = await comp('burst');
  await renderMedia({ serveUrl, composition: burst, codec: 'vp9', imageFormat: 'png', pixelFormat: 'yuva420p', crf: 30, outputLocation: join(ASSETS, 'sparkle-burst.webm'), browserExecutable, muted: true });
  console.log(`sparkle-burst.webm ${await kb(join(ASSETS, 'sparkle-burst.webm'))}`);
  if (prores) {
    await renderMedia({ serveUrl, composition: burst, codec: 'prores', proResProfile: '4444', imageFormat: 'png', pixelFormat: 'yuva444p10le', outputLocation: join(ROOT, 'projects', 'northfield-fixture', '.demo-studio', 'sparkle-burst.mov'), browserExecutable, muted: true });
    console.log(`.demo-studio/sparkle-burst.mov ${await kb(join(ROOT, 'projects', 'northfield-fixture', '.demo-studio', 'sparkle-burst.mov'))} (git-ignored)`);
  }

  // Lottie animations (hand-written bodymovin JSON).
  await writeFile(join(ASSETS, 'cup-steam.json'), `${JSON.stringify(cupSteam())}\n`);
  await writeFile(join(ASSETS, 'check-badge.json'), `${JSON.stringify(checkBadge())}\n`);
  await writeFile(join(PREVIEW, 'lottie-sample.json'), `${JSON.stringify(cupSteam())}\n`);

  const metaFile = join(PREVIEW, 'samples.json');
  const meta = JSON.parse(await readFile(metaFile, 'utf8'));
  const cup = cupSteam();
  meta.media = { ...(meta.media ?? {}), image: { file: 'media-sample.png', width: 1200, height: 900 }, lottie: { file: 'lottie-sample.json', width: cup.w, height: cup.h, fps: cup.fr, frames: cup.op - cup.ip } };
  await writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  console.log('lottie files and samples.json written');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
