/**
 * old-name: this whole file (it names the old spellings it looks for).
 *
 * L5.13 — the old name is gone: no file of the repository says "Demo Studio" (any spelling: demo-studio, DEMO_STUDIO_,
 * demoStudio, wrapped across a line), runs the old command (`studio <sub>`, `pnpm studio`, `Usage: studio`…), or names
 * the old workspace file or home. Since v0.2.1 no code knows an old name (the legacy modules, their tests, the rename
 * script and the upgrade guide are gone: an installation of that time is simply not seen). What is left:
 * - this test, whole;
 * - the history lines of the records: in the files listed in TAGGED only, a line carrying `old-name:` or a region between `old-name:begin` and
 *   `old-name:end` (critique L6: a tag elsewhere is itself a failure, so a count cannot hide a new leftover).
 * Scanned: every tracked file, and the untracked files git does not ignore under the source folders (a new file is
 * checked before it is committed; a person's own notes elsewhere are not) — their contents and their paths (a file or
 * folder of the old name, e.g. a skill folder brought back by a rebase). Kept, not old names: the built-in `studio/`
 * component namespace, the `studio` comment channel, the `studio:*` page events and "the Studio" (the web app).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..', '..');

/** The command's sub-commands (Commander's, the hidden worker, and the ones the docs name before they exist). */
const SUB = [
  'export-capture',
  'components',
  'validate',
  'sandbox',
  'inspect',
  'comment',
  'doctor',
  'record',
  'render',
  'review',
  'export',
  'schema',
  'worker',
  'migrate',
  'skills',
  'player',
  'outline',
  'delete',
  'theme',
  'still',
  'hooks',
  'login',
  'prune',
  'shell',
  'draft',
  'list',
  'plan',
  'auth',
  'jobs',
  'help',
  'lint',
  'new',
  'run',
  'env',
  'mcp',
  'ui',
];
const WRAP = String.raw`(?:[ \t]*\n[ \t]*(?:(?:\*|\/\/|#|>)[ \t]+)?|[ \t]+)`;
const NEXT = String.raw`(?:(?:${SUB.join('|')})(?![\w-])|…|\.\.\.|\$\{|<[A-Za-z]|\[|-{1,2}[A-Za-z])`;

export const PATTERNS: ReadonlyArray<[string, RegExp]> = [
  // Separators: spaces, `_ . -`, a wrap, and the regex-source forms (`Demo\s+Studio`, JSON's `\\s*`, `[\s-]?`).
  ['the name', /demo(?:[\s_.\-\u00a0]|\\+[sSwW][+*?]?|\[[^\]\n]{0,12}\][+*?]?)*(?:\n[\s*#/>]*)?studio/gi],
  ['the command', new RegExp(String.raw`(?<![\w./@:$\\-])studio(?=${WRAP}${NEXT})`, 'g')],
  ['the command', new RegExp(String.raw`(?<=[(\[,=:!\s]\/\^?)studio(?=${WRAP}${NEXT})`, 'g')],
  ['the command', /\b(?:Usage:|pnpm|alias) studio\b|\/studio\( -C\b|'studio '|\/\^studio \/|\bcli: 'studio'|FileJobQueue\([^()\n]*?, 'studio'\)|runCommandLine\('studio',/g],
  ['the command', /new Command\('studio'\)|"studio":\s*"(?:\.\/dist\/bin\.js|node packages)/g],
  ['the command', /`studio`(?=\s*(?:command|CLI|program|on\s+(?:[*#]\s+)?(?:their|your)\s+PATH))|\bstudio(?= needs Node| (?:command|entry point)\b)/g],
  ['the command', /(?<=CLI \()`studio`(?=[,)])/g],
  ['the plugin key', /user_config\.studio\b|--config studio=/g],
  ['the workspace file', /\bstudio\\?\.yaml\b/g],
  ['the home', /\bstudio[ \t]+home\b|\bstudio(?:Home|_home)\b/gi],
];

/** Whole files that are about the old names. */
const WHOLE: readonly RegExp[] = [/^packages\/core\/test\/old-name\.test\.ts$/];

/** Files whose `old-name:` lines and regions are allowed, and why. */
const TAGGED: Readonly<Record<string, string>> = {
  'docs/DESIGN.md': 'the L5.13 section',
  'docs/BACKLOG.md': 'the history line, BL-136',
  'docs/HANDOFF.md': 'the history line',
  'docs/ROADMAP.md': "L5.13's row and paragraph",
};

/** Source folders whose untracked (not ignored) files are scanned too. */
const SOURCE_DIRS = ['packages/', 'apps/', 'docs/', 'scripts/', 'skills/', 'templates/', 'fixtures/', 'projects/', '.claude-plugin/'];
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|mp4|mov|webm|woff2?|ttf|otf|pdf|zip|gz|sqlite|wasm)$/i;

export interface Hit {
  line: number;
  what: string;
  text: string;
}

/** The old names in a text; `tagged`: `old-name:` lines and regions are skipped (an unclosed region is a hit). */
export function oldNameHits(text: string, tagged: boolean): Hit[] {
  const lines = text.split('\n');
  const kept = new Array<boolean>(lines.length).fill(false);
  const out: Hit[] = [];
  if (tagged) {
    let open = -1;
    lines.forEach((l, i) => {
      if (l.includes('old-name:begin')) open = i;
      if (open >= 0 || l.includes('old-name:')) kept[i] = true;
      if (l.includes('old-name:end')) open = -1;
    });
    if (open >= 0) out.push({ line: open + 1, what: 'an old-name region never closed', text: lines[open].trim() });
  }
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineOf = (at: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  for (const [what, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const i = lineOf(m.index ?? 0);
      if (kept[i]) continue;
      out.push({ line: i + 1, what, text: lines[i].trim().slice(0, 160) });
    }
  }
  return out;
}

/** The old names in a repository path (a file's, so its folders' too). */
export function pathHits(path: string): Hit[] {
  return oldNameHits(path, false);
}

function scannedFiles(): string[] {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\0')
      .filter(Boolean);
  const untracked = git(['ls-files', '-z', '-o', '--exclude-standard']).filter((f) => SOURCE_DIRS.some((d) => f.startsWith(d)));
  const tracked = git(['ls-files', '-z', '-c']);
  return [...new Set([...tracked, ...untracked])].filter((f) => !BINARY.test(f)).sort();
}

describe('the old name is gone (L5.13)', () => {
  it('the scanner: every spelling and form of the old name and command; never the kept namespace, channel, events or "the Studio"', () => {
    for (const planted of [
      'Demo Studio',
      'the Demo\n * Studio repository',
      'the lint uses `/Demo\\s+Studio/i`',
      '"evidence": "`/Demo\\\\s+Studio/i`"',
      'const re = /demo[\\s_-]*studio/i',
      'DEMO_STUDIO_X=1',
      'window.__demoStudioCursor',
      'mkdtemp("demo-studio-session-")',
      '`studio run northfield quote`',
      'then run studio ui again',
      'the command studio\n  // export-capture northfield',
      'message: `studio ${name} is available`',
      'Usage: studio [options]',
      "if (!fix.startsWith('studio ')) return",
      "const ctx = { ws, cli: 'studio', input }",
      "new FileJobQueue(root, 'studio')",
      'expect(r.err).toMatch(/studio render <project>/)',
      'hint: expect.stringMatching(/studio( -C \\S+)? sandbox init fx/)',
      'pnpm studio doctor',
      'the `studio` command a human runs',
      'NEVER run the `retake` CLI (`studio`, `pnpm retake`)',
      '## 4. CLI (`studio`)',
      'without `studio` on\n * their PATH',
      'studio needs Node.js 22',
      'the studio.yaml file',
      '/studio\\.yaml:1:1 error/',
      'the studio home',
      'studioHome()',
      "new Command('studio')",
      '--config studio=/r/bin.js',
    ])
      expect(oldNameHits(planted, false).length, planted).toBeGreaterThan(0);
    for (const kept of [
      'card: studio/card-title',
      "window.dispatchEvent(new CustomEvent('studio:command'))",
      "author: { via: 'studio' }",
      'the Studio writes the channel `studio`',
      'Open the Studio',
      'a thread by studio whose change',
      'ui/src/server/studio.ts, studio-e2e-run.test.ts',
      "comments.apply('demo', studioId)",
      '`retake run`, the retake.yaml file, RETAKE_HOME',
      'a demo of the Studio',
    ])
      expect(oldNameHits(kept, false), kept).toEqual([]);
  });

  it('no legacy module is allowed any more (v0.2.1); a path of the old name is a hit (reviews B L2, B L4)', () => {
    for (const f of ['packages/core/src/legacy.ts', 'packages/engine/src/legacy.ts', 'packages/ui/src/legacy.ts', 'scripts/rename-l513.mjs'])
      expect(
        WHOLE.some((re) => re.test(f)),
        f,
      ).toBe(false);
    for (const path of ['skills/demo-studio-scenario/SKILL.md', 'projects/x/studio.yaml', 'docs/DemoStudio.md']) expect(pathHits(path).length, path).toBeGreaterThan(0);
    for (const path of ['skills/retake-scenario/SKILL.md', 'packages/ui/src/server/studio.ts', 'packages/components/library/studio/card-title/index.tsx']) expect(pathHits(path), path).toEqual([]);
  });

  it('tags: an old-name line or region hides only itself, in a TAGGED file; an unclosed region is a failure', () => {
    expect(oldNameHits('a\nthe Demo Studio // old-name: why\nb', true)).toEqual([]);
    expect(oldNameHits('<!-- old-name:begin -->\nDemo Studio\nstudio run x\n<!-- old-name:end -->\nDemo Studio', true)).toEqual([{ line: 5, what: 'the name', text: 'Demo Studio' }]);
    expect(oldNameHits('# old-name:begin\nDemo Studio', true).map((h) => h.what)).toContain('an old-name region never closed');
    expect(oldNameHits('the Demo Studio // old-name: why', false)).toHaveLength(1);
  });

  it('no file of the repository holds an old name outside the allowed places', () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(500);
    const found: string[] = [];
    for (const f of files) {
      // The path (a file deleted in the working tree is not there any more: an old path renamed, not staged yet).
      if (existsSync(join(REPO, f))) for (const h of pathHits(f)) found.push(`${f}: a path of the old name (${h.what})`);
      let text: string;
      try {
        const buf = readFileSync(join(REPO, f));
        if (buf.subarray(0, 8000).includes(0)) continue;
        text = buf.toString('utf8');
      } catch {
        continue; // deleted in the working tree
      }
      if (WHOLE.some((re) => re.test(f))) continue;
      const tagged = Object.hasOwn(TAGGED, f);
      if (!tagged && /old-name:/.test(text)) found.push(`${f}: an old-name tag outside the TAGGED files`);
      for (const h of oldNameHits(text, tagged)) found.push(`${f}:${h.line}: ${h.what}: ${h.text}`);
    }
    expect(found).toEqual([]);
  });
});
