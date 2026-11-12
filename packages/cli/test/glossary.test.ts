/**
 * The glossary (docs/GLOSSARY.md) in the interfaces: `retake new --theme` (with `--template`, its old name, still
 * accepted and no longer shown), and the retired words of the glossary's table absent from the CLI help, from the
 * MCP tools' titles, descriptions and argument descriptions (the tool and argument names themselves stay) and from the
 * engine's admission refusals as MCP words them (the Studio's keep its own labels).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOLS, protocolTool } from '@retake/mcp';
import { admission } from '@retake/engine';
import type { JobRecord, PreparedTake } from '@retake/engine';
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

/**
 * The pattern of a retired word with its common inflections (-s, -es, -ed, -ing; a final "e" dropped before them:
 * rehearse → rehearsed, rehearsing), or of a phrase with any spacing whose last word may take a plural.
 */
function retiredPattern(w: string): string {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (w.includes(' ')) return `${esc(w).replace(/ /g, '\\s+')}s?`;
  return w.endsWith('e') ? `${esc(w.slice(0, -1))}(?:e|es|ed|ing)` : `${esc(w)}(?:s|es|ed|ing)?`;
}

/** Where a retired word (or one of its inflections; a phrase with any spacing) appears in a text, case-insensitive. */
function findRetired(text: string, words: readonly string[]): string[] {
  const hits: string[] = [];
  for (const w of words) {
    const re = new RegExp(`\\b${retiredPattern(w)}\\b`, 'gi');
    for (const m of text.matchAll(re)) hits.push(`"${m[0]}" in …${text.slice(Math.max(0, m.index! - 40), m.index! + m[0].length + 40).replace(/\s+/g, ' ')}…`);
  }
  return hits;
}

/**
 * The error messages written into a zod schema (a check's message such as `.regex(re, '…')`, a schema's own error):
 * zod 4 keeps each one as a function of the issue, which returns the given string.
 */
function zodMessages(schema: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown): void => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    const def = (v as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (def) {
      if (typeof def.error === 'function') {
        try {
          const m = (def.error as (iss: unknown) => unknown)({ code: 'custom', input: undefined, path: [] });
          if (typeof m === 'string') out.push(m);
          else if (m && typeof (m as { message?: unknown }).message === 'string') out.push((m as { message: string }).message);
        } catch {
          // An error function of its own that needs a real issue: not a fixed text.
        }
      }
      for (const x of Object.values(def)) visit(x);
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) visit(x);
  };
  visit(schema);
  return out;
}

/** Every title, description and validation message an MCP client reads: the tool's own and those of its input schema. */
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
    for (const m of zodMessages(t.input)) out.push({ tool: t.name, text: m });
  }
  return out;
}

const WORDS = retiredWords(readFileSync(join(ROOT, 'docs/GLOSSARY.md'), 'utf8'));

/**
 * Every refusal of the engine's admission rules (admission.ts) worded for a channel: a dry run and a capture of the
 * scenario queued, personas to confirm (one checked first, one not), a render queued, an export of the render queued,
 * the workspace's exports at the cap.
 */
async function admissionRefusals(channel: 'mcp' | 'studio'): Promise<string[]> {
  const job = (id: string, input: Record<string, unknown>) => ({ id, state: 'queued', input: { version: 1, submitted_by: 'test', ...input } }) as unknown as JobRecord;
  const take = { project: {}, scenario: { name: 's', scenario: {} }, env: undefined } as unknown as PreparedTake;
  const out: string[] = [];
  const refusal = async (p: Promise<unknown>) => {
    const e = await p.then(() => undefined, (x: unknown) => x as Error);
    expect(e, 'an admission refusal').toBeInstanceOf(Error);
    out.push(e!.message);
  };
  const of = (jobs: JobRecord[], personas: Array<{ persona: string; status: string; auto: boolean; has_check: boolean }> = []) =>
    admission({ channel, queue: { list: async (f) => jobs.filter((j) => !f?.kinds || f.kinds.includes(j.input.kind)), exclusive: (_key, fn) => fn() }, sessions: async () => ({ personas }) });
  for (const mode of ['dry', 'capture'] as const) {
    await refusal(of([job('j1', { kind: 'run', project: 'p', scenario: 's', mode, run_id: '20261109-120000-s' })]).run({ project: 'p', scenario: 's', mode: 'dry' }, async () => undefined));
  }
  const personas = [{ persona: 'a', status: 'never', auto: false, has_check: true }, { persona: 'b', status: 'expired', auto: false, has_check: false }];
  for (const list of [personas, personas.slice(0, 1)]) await refusal(of([], list).run({ project: 'p', scenario: 's', mode: 'capture' }, (admit) => admit.prepared(take)));
  await refusal(of([job('j2', { kind: 'render', project: 'p', scenario: 's', render_id: 's-v2' })]).render({ project: 'p', scenario: 's' }, async () => undefined));
  await refusal(of([job('j3', { kind: 'export', project: 'p', render_id: 's-v2' })]).export({ project: 'p', render_id: 's-v2' }, async () => undefined));
  await refusal(of([job('j4', { kind: 'export', project: 'p', render_id: 's-v3' }), job('j5', { kind: 'export', project: 'p', render_id: 's-v4' })]).export({ project: 'p', render_id: 's-v2' }, async () => undefined));
  return out;
}

describe('the glossary in the CLI and the MCP tools', () => {
  // The words come from the glossary's table (a new row needs no change here); this checks the table is read whole.
  it("reads the retired words from every row of the glossary's table: lower-case words or phrases", () => {
    const rows = readFileSync(join(ROOT, 'docs/GLOSSARY.md'), 'utf8').split('<!-- retired-words:start -->')[1]!.split('<!-- retired-words:end -->')[0]!.split('\n').filter((l) => l.startsWith('| '));
    expect(WORDS.length).toBeGreaterThan(0);
    expect(WORDS.length).toBe(rows.length - 1); // the header row is not a word
    for (const w of WORDS) expect(w).toMatch(/^[a-z]+( [a-z]+)*$/);
    expect(WORDS).toContain('rehearse');
    expect(WORDS).toContain('template name');
  });

  it('finds a retired word, its plural, its inflections and a phrase across a line break, and not inside another word', () => {
    const found = (text: string) => findRetired(text, WORDS).map((h) => h.split(' in ')[0]);
    expect(found('Start a Rehearsal; two rehearsals; the template\n name; broadcast; a production')).toEqual(['"Rehearsal"', '"rehearsals"', '"template\n name"']);
    expect(found('rehearsed, rehearsing, rehearses; shooting, shoots; casting, casts; locations; template names')).toEqual(['"rehearsed"', '"rehearsing"', '"rehearses"', '"shooting"', '"shoots"', '"casting"', '"casts"', '"locations"', '"template names"']);
    expect(found('a screenshot, the forecast, located, relocation, productionsite')).toEqual([]);
  });

  it("reads the validation messages of a tool's input schema", () => {
    const create = TOOLS.find((t) => t.name === 'project_create')!;
    expect(zodMessages(create.input)).toEqual(expect.arrayContaining(['a theme name of the workspace or a starter theme (never a path)', expect.stringContaining('a project slug')]));
  });

  it('the help of every command uses none of them', () => {
    const help = helpTexts();
    expect(help.length).toBeGreaterThan(40);
    const hits = help.flatMap((h) => findRetired(h, WORDS));
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('the descriptions of the YAML schemas (packages/core/schema, what an editor shows) use none of them', () => {
    const dir = join(ROOT, 'packages/core/schema');
    const texts: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k === 'description' || k === 'title') && typeof x === 'string' ? texts.push(x) : walk(x);
    };
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.schema.json'))) walk(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    expect(texts.length).toBeGreaterThan(100);
    const hits = texts.flatMap((t) => findRetired(t, WORDS));
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it("the engine's admission refusals use none of them as MCP words them; the Studio's keep its labels", async () => {
    const mcp = await admissionRefusals('mcp');
    expect(mcp).toHaveLength(7);
    const hits = mcp.flatMap((m) => findRetired(m, WORDS));
    expect(hits, hits.join('\n')).toEqual([]);
    // MCP is told the tools that follow up; the Studio's words are its screens' (its Rehearse button).
    expect(mcp[0]).toMatch(/^a dry run of s is queued .*\(run_status\).*\(run_cancel\)$/);
    expect(mcp[2]).toMatch(/sign in first \(auth_login\), or confirm the capture \(sessions_ack naming them\)$/);
    expect(mcp[3]).toMatch(/\(sessions_ack naming it\)$/);
    const studio = await admissionRefusals('studio');
    expect(studio[0]).toBe('a rehearsal of s is queued (20261109-120000-s): wait for it to end, or stop it');
    expect(studio[2]).toMatch(/: sign in first, or confirm the capture$/);
  });

  it("the MCP tools' titles, descriptions, argument descriptions and validation messages use none of them", () => {
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
