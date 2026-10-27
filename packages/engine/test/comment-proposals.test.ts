/**
 * L4.6 part A2 (T3): Claude's proposal on a frame comment, checked when it is written (engine comment-proposals.ts
 * buildProposal through comments.reply with `proposal`). A proposal is the whole new text of the thread's own
 * scenario file and the hash Claude read; it is stored as the canonical line diff of the exact bytes Apply would write
 * (the file's own line break, a final one included) — only when the Studio would accept it at Apply (prepareScenarioEdit
 * as replace_text with agent trust from the Studio: hooks and mocks unchanged, vars / env unchanged while there are
 * some, no secret reference, no outside file, valid YAML…), it is an edit-only change (critique B2), within the caps
 * (critique B13), on an open thread, from the MCP (critique B10). A refusal writes nothing: thread and scenario bytes
 * unchanged. ⚑ marks the rules a mutation check reverted. The view of a proposal (critique B1 / B15): its state and the
 * rows a person reads, computed by the engine from the file. Fixes after the reviews: ⚑ a diff of more than 600 rows,
 * ⚑ a theme change and ⚑ a lone surrogate are refused (review A M1 / L3 / L6); ⚑ a base without a final line break
 * reads verified once applied (review B L1).
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScenarioError } from '@demo-studio/core';
import type { CommentThread } from '@demo-studio/core';
import { EngineError, createEngine } from '../src/index.js';
import type { Engine } from '../src/index.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const RUN = '20261027-090000-quote';
const PROJECT = 'name: W\nenvironments:\n  local: {app: "http://app.test"}\n  other: {app: "http://other.test"}\ntemplate: default\n';
const TEXT = `video: Quote
title: {text: Quote}
intro: false
outro: false
scenes:
  - id: a
    page: app
    open: /
    caption: A very long caption that says too much
    steps:
      - hold: 1
      - click: Go
`;
const SHORTER = TEXT.replace('A very long caption that says too much', 'A short caption');
const HOOKED = TEXT.replace('scenes:', 'vars: {note: one}\nsetup:\n  - http: {method: POST, url: "{{app}}/reset"}\nscenes:');
const MOCKED = TEXT.replace('scenes:', 'env: local\nmocks:\n  - match: POST app:/x\n    status: 200\nscenes:');

let ws: string;
let dir: string;
let mcp: Engine;
let ui: Engine;
let cli: Engine;
const savedHome = process.env.DEMO_STUDIO_HOME;
let n = 0;

const scenarioFile = (name: string) => join(dir, 'scenarios', `${name}.yaml`);
const threadPath = (scenario: string, id: string) => join(dir, 'comments', scenario, `${id}.json`);

async function failure(p: Promise<unknown>): Promise<Error> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(Error);
  return e as Error;
}

/** A scenario file with a hand-made open thread on it (a Studio thread: via studio); its id. */
async function setup(scenario: string, text: string | Buffer, o: { resolved?: boolean } = {}): Promise<string> {
  await writeFile(scenarioFile(scenario), text);
  const id = `c_01JQ0000000000000000000${String(++n).padStart(3, '0')}`;
  await mkdir(join(dir, 'comments', scenario), { recursive: true });
  const entries = o.resolved ? [{ id: 'r_01JQ00000000000000000000R1', kind: 'resolve', author: { via: 'cli', name: 'Reviewer' }, text: 'Done.', created_at: '2026-10-27T09:10:00.000Z' }] : [];
  await writeFile(
    threadPath(scenario, id),
    JSON.stringify({
      version: 1,
      id,
      scenario,
      render: { id: `${scenario}-v1`, created_at: '2026-10-27T09:01:00.000Z', run_id: RUN, variant: 'landscape', fps: 30, frames: 90, width: 1920, height: 1080 },
      frame: 30,
      time_s: 1,
      text: 'The caption says too much.',
      author: { via: 'studio', name: 'Reviewer' },
      created_at: '2026-10-27T09:05:00.000Z',
      anchor: { segment: 'a', kind: 'clip', scene: 'a', step: 0, area: 'caption' },
      entries,
    }),
  );
  return id;
}

/** The bytes and mtime of a thread and its scenario: unchanged after a refusal. */
async function bytes(scenario: string, id: string): Promise<string[]> {
  return [
    (await readFile(threadPath(scenario, id))).toString('hex'),
    (await readFile(scenarioFile(scenario))).toString('hex'),
    String((await stat(scenarioFile(scenario))).mtimeMs),
  ];
}

const propose = (scenario: string, id: string, yaml: string, hash: string, engine: Engine = mcp) =>
  engine.comments.reply('w', id, 'Proposed a change.', { proposal: { scenario_yaml: yaml, scenario_hash: hash } });

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ds-comment-proposals-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await writeFile(join(ws, 'studio.yaml'), 'projects_dir: projects\n');
  dir = join(ws, 'projects', 'w');
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await mkdir(join(dir, 'runs', RUN), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), PROJECT);
  await writeFile(join(ws, 'projects', 'outside.txt'), 'outside\n');
  // The commented take's snapshot: the file as it was captured.
  await writeFile(join(dir, 'runs', RUN, 'scenario.yaml'), TEXT);
  mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
  ui = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
  cli = await createEngine({ root: ws, client: 'cli', autoStartWorker: false });
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('a proposal written (T3)', () => {
  it('stored as the canonical diff of the exact bytes Apply writes (final line break added), the scenario untouched; the view says pending', async () => {
    const id = await setup('quote', TEXT);
    const before = await bytes('quote', id);
    // Claude's text without its final line break: the result has the file's.
    const w = await propose('quote', id, SHORTER.trimEnd(), sha(TEXT));
    const stored = JSON.parse(await readFile(threadPath('quote', id), 'utf8')) as CommentThread;
    const e = stored.entries.at(-1)!;
    expect(e).toMatchObject({ kind: 'reply', author: { via: 'mcp', name: 'agent' }, text: 'Proposed a change.' });
    expect(e.proposal).toEqual({
      base_sha256: sha(TEXT),
      result_sha256: sha(SHORTER),
      eol: 'lf',
      delta: 'edit',
      hunks: [{ at: 9, del: ['    caption: A very long caption that says too much'], add: ['    caption: A short caption'] }],
    });
    expect((await bytes('quote', id)).slice(1)).toEqual(before.slice(1));
    expect(w.thread.entries.at(-1)?.proposal).toEqual({ state: 'pending', actionable: true, delta: 'edit', added: 1, removed: 1, hunks: 1, base_sha256: sha(TEXT), result_sha256: sha(SHORTER) });
    expect(w.proposal_warnings).toEqual(expect.any(Array));
    // The list carries the summary, never the lines.
    const listed = (await mcp.comments.list('w', { scenario: 'quote' })).threads.find((t) => t.id === id)!;
    expect(listed.entries.at(-1)?.proposal?.state).toBe('pending');
    expect(JSON.stringify(listed)).not.toContain('A short caption');
  });

  it('the view (critique B1 / B15): rows computed from the file with context, verified; same take; lines only under untrusted', async () => {
    const id = await setup('view', TEXT);
    await propose('view', id, SHORTER, sha(TEXT));
    const v = await mcp.comments.proposal('w', id);
    expect(v).toMatchObject({ comment_id: id, scenario: 'view', state: 'pending', actionable: true, verified: true, same_take: true, added: 1, removed: 1, hunks: 1, today_sha256: sha(TEXT) });
    expect(v.rows.map((r) => r.kind)).toEqual(['gap', 'context', 'context', 'context', 'del', 'add', 'context', 'context', 'context']);
    expect(v.rows[0]).toEqual({ kind: 'gap', count: 5 });
    expect(v.rows[4]).toEqual({ kind: 'del', base: 9 });
    expect(v.rows[5]).toEqual({ kind: 'add', line: 9 });
    expect(v.untrusted.rows[5]).toBe('    caption: A short caption');
    expect(v.untrusted.rows.length).toBe(v.rows.length);
    expect(JSON.stringify({ ...v, untrusted: undefined })).not.toContain('caption:');
    expect(v.rewrites_pct).toBe(8);
  });

  it('⚑ the rows read like the files (L4.6 part D2): close changes share their context, no line twice — context and removed rows (and gaps) are the base in order, context and added rows the result', async () => {
    const id = await setup('rows', TEXT);
    const next = TEXT.replace('title: {text: Quote}\n', 'title: {text: Quote} \n').replace('outro: false\n', 'outro: false\n# a note\n').replace('A very long caption that says too much', 'A short caption');
    await propose('rows', id, next, sha(TEXT));
    const v = await mcp.comments.proposal('w', id);
    expect(v).toMatchObject({ verified: true, added: 3, removed: 2, hunks: 3 });
    const base = TEXT.split('\n').slice(0, -1);
    const result = next.split('\n').slice(0, -1);
    const before: string[] = [];
    const after: string[] = [];
    v.rows.forEach((r, i) => {
      const t = v.untrusted.rows[i];
      if (r.kind === 'gap') {
        for (let k = 0; k < r.count!; k++) {
          before.push(base[before.length]);
          after.push(result[after.length]);
        }
        return;
      }
      if (r.kind !== 'add') {
        expect(r.base, `row ${i}`).toBe(before.length + 1);
        before.push(t);
      }
      if (r.kind !== 'del') {
        expect(r.line, `row ${i}`).toBe(after.length + 1);
        after.push(t);
      }
    });
    expect(before).toEqual(base);
    expect(after).toEqual(result);
  });

  it('⚑ a file without its final line break: once applied the proposal still reads verified, with its context (review B L1)', async () => {
    const bare = TEXT.trimEnd();
    const id = await setup('bare', bare);
    const w = await propose('bare', id, SHORTER, sha(bare));
    const pending = await ui.comments.proposal('w', id);
    expect(pending).toMatchObject({ state: 'pending', verified: true });
    await ui.comments.apply('w', id, { entry_id: w.entry, if_match: w.hash });
    expect(await readFile(scenarioFile('bare'), 'utf8')).toBe(SHORTER);
    const applied = await ui.comments.proposal('w', id);
    expect(applied).toMatchObject({ state: 'applied', verified: true, actionable: false });
    expect(applied.rows.map((r) => r.kind)).toEqual(pending.rows.map((r) => r.kind));
    expect(applied.untrusted.rows).toEqual(pending.untrusted.rows);
  });

  it('a CR LF file: the proposal keeps its line breaks (an LF text is joined with CR LF); a file mixing both is refused', async () => {
    const crlf = TEXT.replace(/\n/g, '\r\n');
    const id = await setup('crlf', crlf);
    const w = await propose('crlf', id, SHORTER, sha(crlf));
    const p = (JSON.parse(await readFile(threadPath('crlf', id), 'utf8')) as CommentThread).entries.at(-1)!.proposal!;
    expect(p).toMatchObject({ eol: 'crlf', base_sha256: sha(crlf), result_sha256: sha(SHORTER.replace(/\n/g, '\r\n')) });
    expect(w.thread.entries.at(-1)?.proposal?.state).toBe('pending');
    const mixed = crlf.replace('title: {text: Quote}\r\n', 'title: {text: Quote}\n');
    const id2 = await setup('mixed', mixed);
    const e = await failure(propose('mixed', id2, SHORTER, sha(mixed)));
    expect(e).toMatchObject({ code: 'refused', message: expect.stringMatching(/mixes LF and CR LF line breaks/) });
  });
});

describe('⚑ write-time refusals: nothing written (T3)', () => {
  const refused = async (scenario: string, base: string, yaml: string, check: (e: Error) => void, o: { hash?: string; engine?: Engine; resolved?: boolean } = {}) => {
    const id = await setup(scenario, base, o.resolved ? { resolved: true } : {});
    const before = await bytes(scenario, id);
    const e = await failure(propose(scenario, id, yaml, o.hash ?? sha(base), o.engine));
    check(e);
    expect(await bytes(scenario, id)).toEqual(before);
    return e;
  };

  it('⚑ what the Studio would refuse at Apply: hooks changed, vars / env changed while there are hooks or mocks, a secret reference, a file outside the project, invalid YAML', async () => {
    await refused('hooks', HOOKED, HOOKED.replace('/reset', '/wipe'), (e) => {
      expect(e).toMatchObject({ code: 'refused', details: { sections: ['setup'] } });
      expect(e.message).toMatch(/^not proposed: setup changed: hooks and mocks run on this Mac/);
    });
    // `note` is used by nothing the take films: only the hook-inputs rule refuses it.
    await refused('vars', HOOKED, HOOKED.replace('vars: {note: one}', 'vars: {note: two}'), (e) => {
      expect(e).toMatchObject({ code: 'refused', details: { sections: ['vars'] } });
      expect(e.message).toMatch(/^not proposed: vars changed: this scenario has hooks or mocks/);
    });
    await refused('env', MOCKED, MOCKED.replace('env: local', 'env: other'), (e) => {
      expect(e.message).toMatch(/^not proposed: env changed: this scenario has hooks or mocks/);
      expect(e).toMatchObject({ code: 'refused' });
    });
    for (const [what, ref] of [
      ['an env secret', '{{env:SHOP_TOKEN}}'],
      ['a keychain secret', '{{keychain:demo/agent}}'],
    ] as const) {
      await refused(`secret-${what.split(' ')[1]}`, TEXT, TEXT.replace('      - click: Go', `      - click: Go\n      - type: {into: {label: Name}, text: "${ref}"}`), (e) => {
        expect(e, what).toBeInstanceOf(ScenarioError);
        expect(e.message).toMatch(/^not proposed: /);
        expect(e.message).toContain('never resolves a secret');
      });
    }
    await refused('outside', TEXT, TEXT.replace('      - click: Go', '      - click: Go\n      - drop_file: {zone: {label: Upload}, path: ../outside.txt}'), (e) => {
      expect(e.message).toMatch(/^not proposed: /);
      expect(e.message).toContain('resolves outside the project folder');
    });
    await refused('yaml', TEXT, TEXT.replace('caption: A very long caption that says too much', 'caption: "unclosed'), (e) => {
      expect(e).toBeInstanceOf(ScenarioError);
      expect(e.message).toMatch(/^not proposed: /);
    });
  });

  it('⚑ edit-only (critique B2): a change of what a capture films is refused with its filmed changes — the direct loop', async () => {
    await refused('filmed', TEXT, TEXT.replace('      - hold: 1', '      - hold: 2'), (e) => {
      expect(e).toMatchObject({ code: 'refused', details: { filmed_changes: ['scene a: step a.0 changed'] } });
      expect(e.message).toMatch(/^not proposed: this changes what a capture films .*save a filmed change with scenario_save, capture again/);
    });
  });

  it('⚑ a stale scenario_hash is a conflict naming the current hash; identical text, line breaks only, a resolved thread, a gone file', async () => {
    const e = await refused('stale', TEXT, SHORTER, (x) => expect(x).toMatchObject({ code: 'conflict', details: { current: sha(TEXT) } }), { hash: sha('an older text') });
    expect(e.message).toMatch(/changed since you read it — scenario_get again/);
    await refused('same', TEXT, TEXT, (x) => expect(x).toMatchObject({ code: 'invalid', message: expect.stringMatching(/nothing to propose/) }));
    // A file without its final line break: adding it alone changes no line (critique B10: a zero-hunk proposal).
    await refused('eolonly', TEXT.trimEnd(), TEXT, (x) => expect(x).toMatchObject({ code: 'invalid', message: expect.stringMatching(/only by its line breaks/) }));
    await refused('resolved', TEXT, SHORTER, (x) => expect(x).toMatchObject({ code: 'conflict', message: expect.stringMatching(/is resolved — a proposal answers an open thread/) }), { resolved: true });
    const id = await setup('gone', TEXT);
    await rm(scenarioFile('gone'));
    expect(await failure(propose('gone', id, SHORTER, sha(TEXT)))).toMatchObject({ code: 'not_found' });
  });

  it('⚑ caps (critique B13): a line over 2,000 UTF-16 units, 30,000 characters, 200 changed lines; a hidden character added; line breaks', async () => {
    await refused('long', TEXT, TEXT.replace('A very long caption that says too much', 'x'.repeat(1990)), (e) => expect(e).toMatchObject({ code: 'invalid', message: expect.stringMatching(/a line of 2003 characters \(UTF-16 units\): at most 2000/) }));
    const comments = (count: number, len: number) => Array.from({ length: count }, (_, i) => `# ${String(i).padEnd(len - 2, 'x')}`).join('\n');
    await refused('chars', TEXT, `${TEXT}${comments(16, 2000)}\n`, (e) => expect(e).toMatchObject({ code: 'invalid', message: expect.stringMatching(/32,000 characters of changed lines/) }));
    await refused('lines', TEXT, `${TEXT}${comments(201, 10)}\n`, (e) => expect(e).toMatchObject({ code: 'invalid', message: expect.stringMatching(/more than 200 changed lines .*byte for byte \(never re-serialised\)/) }));
    await refused('zwsp', TEXT, TEXT.replace('A very long caption', 'A very​ long caption'), (e) => expect(e).toMatchObject({ code: 'invalid', message: expect.stringMatching(/U\+200B \(a zero-width space\)/) }));
    await refused('mixedtext', TEXT, SHORTER.replace('title: {text: Quote}\n', 'title: {text: Quote}\r\n'), (e) => expect(e).toMatchObject({ code: 'invalid', message: expect.stringMatching(/mixes LF and CR LF/) }));
    await refused('lonecr', TEXT, SHORTER.replace('title: {text: Quote}\n', 'title: {text: Quote}\r'), (e) => expect(e).toMatchObject({ code: 'invalid', message: expect.stringMatching(/carriage return without a line feed/) }));
  });

  it('⚑ critique B10: a line holding a hidden character is never removed or changed by a proposal', async () => {
    const hidden = TEXT.replace('A very long caption that says too much', 'A very long⁠ caption');
    await refused('hiddenline', hidden, SHORTER, (e) => {
      expect(e).toMatchObject({ code: 'refused', details: { line: 9 } });
      expect(e.message).toBe('not proposed: line 9 of scenarios/hiddenline.yaml holds U+2060 (a word joiner) — a proposal never removes or changes such a line: the person changes it in their editor');
    });
  });

  it('⚑ fixes after the reviews: a diff of more than 600 rows (review A M1), a theme change (review A L3), half a character (review A L6) are refused', async () => {
    // 100 one-line changes spread through a long file: within 200 changed lines, but 800 rows with their context.
    const notes = Array.from({ length: 100 }, (_, i) => `# note ${i}\n# keep a\n# keep b\n# keep c\n# keep d\n# keep e\n# keep f\n# keep g`).join('\n');
    const long = `${TEXT}${notes}\n`;
    const e = await refused('rowsmax', long, long.replace(/# note (\d+)/g, '# note $1 tidied'), (x) => expect(x).toMatchObject({ code: 'invalid', details: { argument: 'proposal.scenario_yaml' } }));
    expect(e.message).toMatch(/^not proposed: the diff the person reads would have [\d,]+ rows \(the changes and 3 unchanged lines around each\): at most 600 — propose fewer changes, closer together$/);
    // A theme is the direct loop: never a proposal (added, changed or removed).
    const themed = TEXT.replace('outro: false\n', 'outro: false\ntemplate: default\n');
    for (const [name, base, next] of [['theme1', TEXT, themed], ['theme2', themed, themed.replace('template: default', 'template: editorial')], ['theme3', themed, TEXT]] as const) {
      const t = await refused(name, base, next, (x) => expect(x).toMatchObject({ code: 'refused', details: { theme_change: true } }));
      expect(t.message).toBe("not proposed: this changes the scenario's theme (template:) — a theme change is never a proposal: save it with scenario_save, render, review, then reply (the direct loop)");
    }
    // A lone surrogate: Apply would write U+FFFD, not the line shown.
    await refused('surrogate', TEXT, TEXT.replace('A very long caption that says too much', 'says \ud800 much'), (x) =>
      expect(x).toMatchObject({ code: 'invalid', message: expect.stringMatching(/half of a character \(a lone UTF-16 surrogate\)/) }),
    );
  });

  it('⚑ critique B10: only the MCP proposes — the Studio and a terminal are refused (a person changes the file)', async () => {
    for (const engine of [ui, cli]) {
      await refused('person', TEXT, SHORTER, (e) => expect(e).toMatchObject({ code: 'refused', message: expect.stringMatching(/a proposal comes from Claude \(comment_reply over MCP\)/) }), { engine });
    }
  });
});
