/**
 * What ran a capture (run.json `engine`, R-PRIN-13): Retake, Node.js, the browser, the OS and the fonts installed
 * on the machine — what makes two machines' takes of one scenario differ (a font missing on a CI runner changes every
 * text the product draws in a system font).
 */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir, platform, release, arch } from 'node:os';
import { join } from 'node:path';
import { RETAKE_VERSION } from '@retake/core/base';
import type { RunEngine } from '@retake/core/model';

/** The folders fonts are installed in, per platform (the user's own last). */
function fontDirs(): Array<{ label: string; dir: string }> {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return [
        { label: 'system', dir: '/System/Library/Fonts' },
        { label: 'library', dir: '/Library/Fonts' },
        { label: 'user', dir: join(home, 'Library/Fonts') },
      ];
    case 'win32': {
      const windir = process.env.WINDIR ?? 'C:\\Windows';
      const local = process.env.LOCALAPPDATA;
      return [{ label: 'system', dir: join(windir, 'Fonts') }, ...(local ? [{ label: 'user', dir: join(local, 'Microsoft', 'Windows', 'Fonts') }] : [])];
    }
    default:
      return [
        { label: 'system', dir: '/usr/share/fonts' },
        { label: 'local', dir: '/usr/local/share/fonts' },
        { label: 'user', dir: join(home, '.local/share/fonts') },
        { label: 'user-legacy', dir: join(home, '.fonts') },
      ];
  }
}

const FONT_FILE = /\.(ttf|otf|ttc|otc|dfont|woff2?|pfb|pcf(\.gz)?)$/i;
/** Depth of the walk under a font folder (Linux sorts fonts in folders by format and family). */
const MAX_DEPTH = 3;
/** A machine with more font files than this is summarised by the first ones (the walk stays a few ms). */
const MAX_FILES = 20_000;

let cachedFonts: RunEngine['fonts'] | null = null;

/** The installed font files: their number and a digest of their sorted names (cached per process). */
export function installedFonts(): RunEngine['fonts'] {
  if (cachedFonts) return cachedFonts;
  const names: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (names.length >= MAX_FILES) return;
      if (e.isDirectory() && depth < MAX_DEPTH) walk(join(dir, e.name), `${rel}/${e.name}`, depth + 1);
      else if (FONT_FILE.test(e.name)) names.push(`${rel}/${e.name}`);
    }
  };
  for (const { label, dir } of fontDirs()) walk(dir, label, 0);
  names.sort();
  cachedFonts = { files: names.length, digest: createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 12) };
  return cachedFonts;
}

/** run.json `engine`: everything but the browser, known before it opens (`chromium` is added once it has). */
export function runEngine(chromium?: string): RunEngine {
  return {
    retake: RETAKE_VERSION,
    node: process.versions.node,
    ...(chromium ? { chromium } : {}),
    os: `${platform()} ${release()} ${arch()}`,
    fonts: installedFonts(),
  };
}
