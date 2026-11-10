/**
 * vitest setupFiles (L5.14, captures first): every test file gets a filming-marker folder of its own (0700) under the
 * run's scratch parent (vitest.config.ts RETAKE_TEST_CAPTURES) — a take one file films never holds a render another file
 * runs at the same time, and no test reads or writes the person's own folder. The processes a test starts inherit it
 * (core test/retake-home.test.ts is the canary). A file that sets its own RETAKE_CAPTURES_DIR keeps it.
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const parent = process.env.RETAKE_TEST_CAPTURES?.trim();
if (parent && !process.env.RETAKE_CAPTURES_DIR?.trim()) process.env.RETAKE_CAPTURES_DIR = mkdtempSync(join(parent, 'file-'));

// L5.15 (critique H4): every test file renders on the software path (no `--use-gl`, libx264 CRF 16) — deterministic
// frame for frame, as Linux renders, at today's suite times. A file that tests the GPU path opts in: it passes
// `settings` to the render, or sets these variables back (to `auto`) itself, and compares SSIM or structure, never
// bytes. RETAKE_TEST_RENDER_POLICY=keep leaves the shell's values (a whole run on the default policy, by hand).
// L7.3: and with the rendering library's own ffmpeg for the frames, whatever ffmpeg the machine has — the pinned bytes
// of the suite do not depend on it. A file that tests our ffmpeg at the encode passes `settings: { ffmpeg: 'own' }`.
if (process.env.RETAKE_TEST_RENDER_POLICY !== 'keep') {
  process.env.RETAKE_RENDER_GL = 'software';
  process.env.RETAKE_RENDER_ENCODER = 'libx264';
  process.env.RETAKE_RENDER_FFMPEG = 'library';
}
