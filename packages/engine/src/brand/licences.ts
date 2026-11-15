/** A new theme's LICENSES.md (create.ts): its artwork, its fonts and what each declares, the base theme's licences. */
import { printableText } from '@retake/core/base';
import type { FontInfo } from './files.js';
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

export function licencesMarkdown(o: {
  name: string;
  base: string;
  date: string;
  logo: { file: string; source: string };
  wordmark?: { file: string; source: string };
  fonts: ThemeFontView[];
  names: Map<string, FontInfo['names']>;
  baseLicences?: string;
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
  const own = o.fonts.filter((f) => f.weight_from !== 'base');
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
