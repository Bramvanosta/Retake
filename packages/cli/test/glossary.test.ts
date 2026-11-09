/**
 * The glossary (docs/GLOSSARY.md) in the interfaces: `retake new --theme` (with `--template`, its old name, still
 * accepted and no longer shown), and the retired words of the glossary's table absent from the CLI help and from the
 * MCP tools' titles, descriptions and argument descriptions (the tool and argument names themselves stay).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOLS, protocolTool } from '@retake/mcp';
import { EXIT, main, memoryIo } from '../src/index.js';
import { helpTexts } from '../src/main.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TEMPLATES = join(ROOT, 'templates');

/** The retired words of the glossary: the first column of the table between its markers. */
function retiredWords(md: string): string[] {
  const block = md.split('<!-- retired-words:start -->')[1]?.split('<!-- retired-words:end -->')[0] ?? '';
  return block
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*(Retired|-)/.test(l))
    .map((l) => l.split('|')[1]!.trim());
}

/** Where a retired word (its plural too; a phrase with any spacing) appears in a text, case-insensitive. */
function findRetired(text: string, words: readonly string[]): string[] {
  const hits: string[] = [];
  for (const w of words) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}s?\\b`, 'gi');
    for (const m of text.matchAll(re)) hits.push(`"${m[0]}" in …${text.slice(Math.max(0, m.index! - 40), m.index! + m[0].length + 40).replace(/\s+/g, ' ')}…`);
  }
  return hits;
}

/** Every title and description an MCP client reads: the tool's own and those of its input schema. */
function toolTexts(): Array<{ tool: string; text: string }> {
  const out: Array<{ tool: string; text: string }> = [];
  const walk = (tool: string, v: unknown): void => {
    if (Array.isArray(v)) v.forEach((x) => walk(tool, x));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'description' || k === 'title') && typeof x === 'string') out.push({ tool, text: x });
        else walk(tool, x);
      }
    }
  };
  for (const t of TOOLS) {
    const p = protocolTool(t, async () => {
      throw new Error('not called');
    });
    out.push({ tool: t.name, text: `${p.title ?? ''}\n${p.description}` });
    walk(t.name, p.inputSchema);
  }
  return out;
}

const WORDS = retiredWords(readFileSync(join(ROOT, 'docs/GLOSSARY.md'), 'utf8'));

describe('the glossary in the CLI and the MCP tools', () => {
  it('reads a short, exact list of retired words from the glossary', () => {
    expect(WORDS).toEqual(['rehearsal', 'rehearse', 'shoot', 'cast', 'location', 'productions', 'template name']);
  });

  it('finds a retired word, its plural and a phrase across a line break, and not inside another word', () => {
    expect(findRetired('Start a Rehearsal; two rehearsals; the template\n name; broadcast; a production', WORDS).map((h) => h.split(' in ')[0])).toEqual(['"Rehearsal"', '"rehearsals"', '"template\n name"']);
  });

  it('the help of every command uses none of them', () => {
    const help = helpTexts();
    expect(help.length).toBeGreaterThan(40);
    const hits = help.flatMap((h) => findRetired(h, WORDS));
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it("the MCP tools' titles, descriptions and argument descriptions use none of them", () => {
    const texts = toolTexts();
    expect(texts.length).toBeGreaterThan(TOOLS.length);
    const hits = texts.flatMap(({ tool, text }) => findRetired(text, WORDS).map((h) => `${tool}: ${h}`));
    expect(hits, hits.join('\n')).toEqual([]);
  });
});

describe('retake new --theme', () => {
  let ws: string;
  const retake = async (...args: string[]) => {
    const io = memoryIo();
    const code = await main(['node', 'retake', '--root', ws, ...args], io);
    return { code, out: io.stdout(), err: io.stderr() };
  };
  const ENV = ['--env', 'staging=app:https://app.staging.example.com'];
  const themeOf = async (slug: string) => /^template: (.+)$/m.exec(await readFile(join(ws, 'projects', slug, 'project.yaml'), 'utf8'))?.[1];

  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), 'retake-glossary-'));
    await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  });
  afterAll(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it('creates the project with that theme', async () => {
    const r = await retake('new', 'with-theme', '--theme', 'editorial', ...ENV);
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(await themeOf('with-theme')).toBe('editorial');
  });

  it('still accepts --template, the old name, and refuses both naming different themes', async () => {
    const r = await retake('new', 'with-template', '--template', 'motion', ...ENV);
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(await themeOf('with-template')).toBe('motion');
    const same = await retake('new', 'with-both', '--theme', 'motion', '--template', 'motion', ...ENV);
    expect(same.code, same.err).toBe(EXIT.ok);
    expect(await themeOf('with-both')).toBe('motion');
    const both = await retake('new', 'with-two', '--theme', 'editorial', '--template', 'motion', ...ENV);
    expect(both.code).toBe(EXIT.usage);
    expect(both.err).toContain('--template is the old name of --theme');
  });

  it('shows --theme in its help, not --template', async () => {
    const r = await retake('new', '--help');
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('--theme <name>');
    expect(r.out).not.toContain('--template');
  });
});
