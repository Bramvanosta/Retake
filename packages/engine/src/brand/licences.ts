/** A new theme's LICENSES.md (create.ts): its artwork, its fonts and what each declares, the base theme's licences. */
import { printableText } from '@retake/core/base';
import type { FontInfo } from './files.js';
import type { FontsourceLicence } from './fontsource-store.js';
import { weightWords } from './theme-fonts.js';
import type { ThemeFontView } from './theme-fonts.js';

/** A file reference inside a code span of LICENSES.md (one line; no backtick, pipe or control). */
function mdCode(s: string | undefined): string {
  return s ? printableText(s).replace(/[|`]+/g, ' ').trim() : '—';
}

/**
 * Third-party text (a font's name strings) as plain Markdown text: one line, every character Markdown or HTML reads as
 * syntax escaped (links, images, emphasis, code, tables, tags) — never a link or a remote image in LICENSES.md.
 */
function mdText(s: string | undefined): string {
  return s ? printableText(s).replace(/[\\`*_[\]()!<>|#~&]/g, '\\$&') || '—' : '—';
}

const TEST_REGISTRY_NOTE = ' — a TEST registry (RETAKE_UNSAFE_TEST_NPM_REGISTRY): never use this theme outside tests';
const FONTSOURCE_HEADING = '## Fonts from fontsource';

/** mdText undone (its backslashes before Markdown characters). */
const unText = (s: string) => s.replace(/\\([\\`*_[\]()!<>|#~&])/g, '$1');

/**
 * The fontsource packages a theme's own LICENSES.md cites (licencesMarkdown's "Fonts from fontsource" section), read
 * back — what template_update gives a font it reuses, so the theme no longer needs the font store for it. By
 * `<package>@<version>`; a block that does not read as one licencesMarkdown wrote is left out (the store is read then).
 */
export function citedFontsourceLicences(own: string): Map<string, FontsourceLicence> {
  const out = new Map<string, FontsourceLicence>();
  const lines = own.split('\n');
  const at = lines.indexOf(FONTSOURCE_HEADING);
  if (at < 0) return out;
  for (let i = at + 1; i < lines.length && !lines[i].startsWith('## '); i++) {
    const h = /^### `([^`]+)` (\S+)$/.exec(lines[i]);
    if (!h) continue;
    const field = (k: number, label: string) => (lines[i + k]?.startsWith(`- ${label}: `) ? lines[i + k].slice(label.length + 4) : undefined);
    const licence = field(2, 'Licence (as its publisher declares it)');
    const registryLine = field(3, 'Registry');
    const tarball = field(4, 'Tarball');
    const integrity = field(5, 'Integrity');
    if (licence === undefined || registryLine === undefined || tarball === undefined || integrity === undefined || field(6, 'Files') === undefined || lines[i + 7] !== '') continue;
    const text: string[] = [];
    let j = i + 8;
    for (; j < lines.length && lines[j].startsWith('>'); j++) text.push(lines[j] === '>' ? '' : unText(lines[j].slice(2)));
    const test = registryLine.endsWith(TEST_REGISTRY_NOTE);
    out.set(`${h[1]}@${h[2]}`, {
      package: h[1],
      version: h[2],
      licence: unText(licence),
      registry: unText(test ? registryLine.slice(0, -TEST_REGISTRY_NOTE.length) : registryLine),
      test_registry: test,
      tarball: unText(tarball),
      integrity: unText(integrity),
      text: text.join('\n'),
    });
    i = j - 1;
  }
  return out;
}

export function licencesMarkdown(o: {
  name: string;
  base: string;
  date: string;
  logo: { file: string; source: string };
  wordmark?: { file: string; source: string };
  fonts: ThemeFontView[];
  names: Map<string, FontInfo['names']>;
  baseLicences?: string;
  /** The fontsource packages its fonts come from (the font store's records), each cited once with its LICENSE text. */
  packages?: FontsourceLicence[];
}): string {
  const lines = [
    `# Licences — \`${o.name}\` theme`,
    '',
    `Made by Retake from brand inputs on ${o.date}, over the \`${o.base}\` theme.`,
    '',
    '## Brand artwork',
    '',
    `- \`${o.logo.file}\` — copied from \`${mdCode(o.logo.source)}\`.`,
    ...(o.wordmark ? [`- \`${o.wordmark.file}\` — copied from \`${mdCode(o.wordmark.source)}\`.`] : []),
    '',
    "The logo and wordmark are the brand's own artwork, supplied by the user of this workspace.",
    '',
    '## Fonts',
    '',
    '| File | Supplied as | Face | Notes |',
    '| --- | --- | --- | --- |',
    ...o.fonts.map(
      (f) =>
        `| \`${f.file}\` | \`${mdCode(f.source)}\` | ${f.role}, ${weightWords(f.weight)}${f.italic ? ' italic' : ''} (${f.format}) | ${f.licence_notes.length ? mdText(f.licence_notes.join('; ')) : '—'} |`,
    ),
    '',
  ];
  const own = o.fonts.filter((f) => f.weight_from !== 'base' && f.package === undefined);
  if (own.length) {
    lines.push(
      'Fonts supplied by the user: check that their licence allows use in videos (text rendered to pixels) and',
      'redistribution with your projects. What each file declares about itself, as found in it:',
      '',
    );
    for (const f of own) {
      const n = o.names.get(f.file) ?? {};
      lines.push(
        `### \`${f.file}\``,
        '',
        `- Family: ${mdText(n.family)} ${n.subfamily ? `(${mdText(n.subfamily)})` : ''}`.trimEnd(),
        `- Copyright: ${mdText(n.copyright)}`,
        `- Licence: ${mdText(n.licence)}`,
        `- Licence URL: ${mdText(n.licence_url)}`,
        ...(f.licence_notes.length ? [`- Embedding: ${mdText(f.licence_notes.join('; '))}`] : []),
        '',
      );
    }
  }
  if (o.packages?.length) {
    lines.push(
      FONTSOURCE_HEADING,
      '',
      "Fetched into the workspace's font store (font_fetch / `retake theme fetch-font`), then copied here. Each package's",
      'licence is the one its publisher declares; its LICENSE text follows as it was in the package.',
      '',
    );
    for (const p of o.packages) {
      const files = o.fonts.filter((f) => f.package === `${p.package}@${p.version}`).map((f) => `\`${f.file}\``);
      lines.push(
        `### \`${mdCode(p.package)}\` ${mdCode(p.version)}`,
        '',
        `- Licence (as its publisher declares it): ${mdText(p.licence)}`,
        `- Registry: ${mdText(p.registry)}${p.test_registry ? TEST_REGISTRY_NOTE : ''}`,
        `- Tarball: ${mdText(p.tarball)}`,
        `- Integrity: ${mdText(p.integrity)}`,
        `- Files: ${files.join(', ') || '—'}`,
        '',
        ...p.text
          .replace(/\r\n?/g, '\n')
          .trimEnd()
          .split('\n')
          .map((l) => (l.trim() === '' ? '>' : `> ${mdText(l)}`)),
        '',
      );
    }
  }
  if (o.baseLicences !== undefined) {
    lines.push(
      `## Fonts of the base theme \`${o.base}\``,
      '',
      `Some font files come from the \`${o.base}\` theme; its LICENSES.md follows as it is (its notes on artwork do not`,
      "apply to this theme's logo and wordmark).",
      '',
      ...o.baseLicences
        .trimEnd()
        .split('\n')
        .map((l) => (l.startsWith('#') ? `##${l}` : l)),
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
