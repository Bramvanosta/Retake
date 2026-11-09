/**
 * Claude's proposed scenario change on a frame comment (L4.6, R-UI-28; critique B1 / B2 / B9 / B10 / B13): the checks a
 * proposal passes before it is stored in a reply, previewed in the timeline or applied, all on the thread's own
 * scenario file (the target is never an argument).
 *
 * - Built from the whole new text Claude writes and the hash `scenario_get` gave it: the text is split into lines and
 *   joined with the file's own line break (a final one included: what `replace_text` writes); the stored hunks are the
 *   canonical line diff (core line-diff.ts) between the file and those exact bytes, within the caps (core
 *   PROPOSAL_*: 200 changed lines, 30,000 characters, lines of ≤ 2,000 UTF-16 units, no hidden character in a removed
 *   or added line).
 * - The Studio's own write checks without the write (scenarios.ts prepareScenarioEdit as `replace_text` with agent
 *   trust from the Studio: the file not blocked, no hidden character added, hooks and mocks unchanged, vars / env
 *   unchanged while there are some, no secret reference, no outside file, no agent-writable code, the scenario valid)
 *   — at write time, at every preview and again by editScenario itself at Apply. A proposal the Studio would refuse is
 *   refused when Claude writes it, with the same words ("not proposed: …").
 * - Edit-only (critique B2): a change of what a capture films (steps, pages, hooks, capture settings, the vars the take
 *   uses) is never a proposal — it is saved and captured, the direct loop.
 * - Rebuilt strictly (critique B1): the file must be the proposal's base, the hunks must apply line for line, the bytes
 *   must have the stored result hash, and the hunks must be the canonical diff of those bytes — else nothing is shown as
 *   exact, previewed or applied.
 */
import {
  CommentProposalSchema,
  canonicalJson,
  PROPOSAL_CHANGED_LINES_MAX,
  SCENARIO_EDIT_MAX_CHARS,
  ScenarioError,
  applyHunks,
  diffLines,
  filmedChangesOf,
  joinLines,
  lineBreaks,
  parseYaml,
  proposalHunksProblem,
  proposalLineProblem,
  sameHunks,
  textEol,
  textLines,
} from '@retake/core';
import type { CommentProposal, LoadedProject, ValidationIssue, FileFacts } from '@retake/core';
import type { ComponentRegistry } from '@retake/components';
import { EngineError } from './errors.js';
import { getScenario, prepareScenarioEdit } from './scenarios.js';
import type { ScenarioText } from './scenarios.js';
import { sha256Hex } from './storage.js';

/** Context lines shown around each change of a proposal (the only lines the diff leaves out are unchanged ones). */
export const PROPOSAL_CONTEXT_LINES = 3;
/**
 * Rows of the diff a person reads, at most (changed lines and their context together; review A M1): the Studio shows
 * every row before its Apply — never a cut —, so a longer diff is refused when Claude writes it.
 */
export const PROPOSAL_ROWS_MAX = 600;

/** One row of the diff a person reads: an unchanged line, a removed one, an added one, or unchanged lines left out. */
export interface ProposalRow {
  kind: 'context' | 'del' | 'add' | 'gap';
  /** 1-based line in the file before (context, del). */
  base?: number;
  /** 1-based line in the file after (context, add). */
  line?: number;
  /** A gap: how many unchanged lines are left out. */
  count?: number;
}

/** Rows of a diff from the base's lines and canonical hunks, with `ctx` context lines (a gap for what lies between). */
export function diffRows(base: readonly string[], hunks: CommentProposal['hunks'], ctx: number = PROPOSAL_CONTEXT_LINES): { rows: ProposalRow[]; texts: string[] } {
  const rows: ProposalRow[] = [];
  const texts: string[] = [];
  let shift = 0; // result line − base line before the next hunk
  let shown = 0; // base lines (1-based) shown or passed so far
  const context = (from: number, to: number) => {
    for (let b = from; b <= to; b++) {
      rows.push({ kind: 'context', base: b, line: b + shift });
      texts.push(base[b - 1]);
    }
  };
  for (const [i, h] of hunks.entries()) {
    const start = Math.max(shown + 1, h.at - ctx);
    if (start > shown + 1) {
      rows.push({ kind: 'gap', count: start - shown - 1 });
      texts.push('');
    }
    context(start, h.at - 1);
    h.del.forEach((l, j) => {
      rows.push({ kind: 'del', base: h.at + j });
      texts.push(l);
    });
    h.add.forEach((l, j) => {
      rows.push({ kind: 'add', line: h.at + shift + j });
      texts.push(l);
    });
    shown = h.at - 1 + h.del.length;
    shift += h.add.length - h.del.length;
    // The context after a change stops before the next one (its own context goes on from there: no line twice).
    const next = hunks[i + 1];
    const end = Math.min(base.length, shown + ctx, next ? next.at - 1 : Infinity);
    context(shown + 1, end);
    shown = end;
  }
  if (shown < base.length) {
    rows.push({ kind: 'gap', count: base.length - shown });
    texts.push('');
  }
  return { rows, texts };
}

/** Why a diff of `rows` rows is too long to be read whole before an Apply, or null. */
export function proposalRowsProblem(rows: number): string | null {
  return rows > PROPOSAL_ROWS_MAX
    ? `the diff the person reads would have ${rows.toLocaleString('en')} rows (the changes and ${PROPOSAL_CONTEXT_LINES} unchanged lines around each): at most ${PROPOSAL_ROWS_MAX} — propose fewer changes, closer together`
    : null;
}

/** What Claude sends with a reply (MCP comment_reply `proposal`): the whole new text and the hash it was read with. */
export interface ProposalInput {
  scenario_yaml: string;
  scenario_hash: string;
}

/** A proposal built and checked, ready to be stored in a reply. */
export interface BuiltProposal {
  proposal: CommentProposal;
  /** The scenario's validation warnings for the proposed text (errors refuse it). */
  warnings: ValidationIssue[];
}

/** What is done with a proposal: the words of a refusal ("not proposed" / "not previewed" / "not applied"). */
type Stage = 'proposed' | 'previewed' | 'applied';

function invalid(message: string, argument?: string): EngineError {
  return new EngineError('invalid', message, argument ? { details: { argument } } : {});
}

/** A refusal of prepareScenarioEdit, worded for the stage ("not saved: …" → "not proposed: …"). */
function restage(e: unknown, stage: Stage): unknown {
  const say = (m: string) => m.replace(/^not saved: /, `not ${stage}: `);
  if (e instanceof ScenarioError) return new ScenarioError(say(e.message), e.issues, e.file);
  if (e instanceof EngineError) return new EngineError(e.code, say(e.message), { ...(e.details !== undefined ? { details: e.details } : {}), ...(e.fix !== undefined ? { fix: e.fix } : {}) });
  return e;
}

/** The file's line break, or a refusal when it mixes LF and CR LF (a proposal is shown and applied line by line). */
function fileEol(today: ScenarioText, stage: Stage): '\n' | '\r\n' {
  const lb = lineBreaks(today.yaml);
  if (lb.crlf > 0 && lb.lf > 0) {
    throw new EngineError('refused', `not ${stage}: ${today.file} mixes LF and CR LF line breaks — a proposal is shown and applied line by line, so the file's line breaks must be one kind: fix them in your editor`);
  }
  return textEol(today.yaml);
}

/** A parsed scenario's `template:` (undefined when it names none or is not a mapping). */
function templateOf(doc: unknown): unknown {
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>).template : undefined;
}

/**
 * The checks every stage runs on the proposed text against today's file (critique B9 a): prepareScenarioEdit as
 * `replace_text` with agent trust from the Studio (nothing written, no version remembered), then edit-only (B2) and no
 * theme change (`template:` as it is).
 */
export async function checkProposedText(
  project: LoadedProject,
  scenario: string,
  today: ScenarioText,
  text: string,
  stage: Stage,
  o: { registry?: () => Promise<ComponentRegistry>; files: FileFacts },
): Promise<ValidationIssue[]> {
  let prepared: Awaited<ReturnType<typeof prepareScenarioEdit>>;
  try {
    prepared = await prepareScenarioEdit(project, scenario, { hash: today.hash, edit: { kind: 'replace_text', text } }, { agent: true, via: 'studio', files: o.files, ...(o.registry ? { registry: o.registry } : {}) });
  } catch (e) {
    throw restage(e, stage);
  }
  // replace_text adds a final line break only when there is none: the proposed text always has one.
  if (prepared.text !== text) throw new EngineError('internal', `not ${stage}: the proposed text would not be written as it is (a final line break): nothing stored`);
  const next = parseYaml(text).value;
  const before = parseYaml(today.yaml).value;
  // A theme change takes the direct loop (critique B2 as amended; review A L3): a render with another theme is another
  // look, and the Studio's "Apply and re-render" / "Resolve with vN" would answer the frame with it.
  if (canonicalJson(templateOf(next) ?? null) !== canonicalJson(templateOf(before) ?? null)) {
    throw new EngineError(
      'refused',
      `not ${stage}: this changes the scenario's theme (template:) — a theme change is never a proposal: save it with scenario_save, render, review, then reply (the direct loop)`,
      { details: { theme_change: true } },
    );
  }
  const filmed = filmedChangesOf(next, before);
  if (filmed.length) {
    throw new EngineError(
      'refused',
      `not ${stage}: this changes what a capture films (${filmed.slice(0, 4).join('; ')}${filmed.length > 4 ? `; and ${filmed.length - 4} more` : ''}) — a proposal is an edit-only change (captions, cards, timing, title, intro / outro, layout): save a filmed change with scenario_save, capture again, review, then reply`,
      { details: { filmed_changes: filmed.slice(0, 20) } },
    );
  }
  return prepared.warnings;
}

/**
 * A proposal from Claude's whole new text of the thread's scenario (`scenario`) — see the module comment. EngineError
 * `conflict` (the file changed since Claude read it), `invalid` (the text: line breaks, caps, identical), `refused`
 * (what the Studio would refuse), ScenarioError (validation errors, with their lines).
 */
export async function buildProposal(project: LoadedProject, scenario: string, input: ProposalInput, o: { registry?: () => Promise<ComponentRegistry>; files: FileFacts }): Promise<BuiltProposal> {
  if (!input || typeof input !== 'object') throw invalid('a proposal is {scenario_yaml, scenario_hash}', 'proposal');
  const raw = input.scenario_yaml;
  if (typeof raw !== 'string' || raw.trim() === '') throw invalid('proposal.scenario_yaml is the whole new text of the scenario file', 'proposal.scenario_yaml');
  if (raw.length > SCENARIO_EDIT_MAX_CHARS) throw invalid(`proposal.scenario_yaml holds ${raw.length.toLocaleString('en')} characters: at most ${SCENARIO_EDIT_MAX_CHARS.toLocaleString('en')}`, 'proposal.scenario_yaml');
  if (typeof input.scenario_hash !== 'string' || !/^[0-9a-f]{64}$/.test(input.scenario_hash)) {
    throw invalid('proposal.scenario_hash is the hash scenario_get returned for the file (64 hex characters)', 'proposal.scenario_hash');
  }
  let today: ScenarioText;
  try {
    today = await getScenario(project, scenario);
  } catch (e) {
    if (e instanceof EngineError && e.code === 'not_found') throw new EngineError('not_found', `not proposed: the thread's scenario file scenarios/${scenario}.yaml is not there`);
    throw e;
  }
  if (today.hash !== input.scenario_hash) {
    throw new EngineError('conflict', `not proposed: ${today.file} changed since you read it — scenario_get again and propose on its new text`, {
      details: { current: today.hash },
      fix: `scenario_get {name: "${scenario}"}, then propose with scenario_hash "${today.hash}"`,
    });
  }
  const eol = fileEol(today, 'proposed');
  const lb = lineBreaks(raw);
  if (lb.cr > 0) throw invalid('not proposed: the text holds a carriage return without a line feed (an editor shows a line break there, YAML reads none)', 'proposal.scenario_yaml');
  if (lb.crlf > 0 && lb.lf > 0) throw invalid('not proposed: the text mixes LF and CR LF line breaks — use one kind (the file\'s own)', 'proposal.scenario_yaml');
  const baseLines = textLines(today.yaml);
  const lines = textLines(raw);
  const text = joinLines(lines, eol);
  if (text === today.yaml) throw invalid(`not proposed: the text is ${today.file} as it is — nothing to propose`, 'proposal.scenario_yaml');
  const hunks = diffLines(baseLines, lines, { maxChanged: PROPOSAL_CHANGED_LINES_MAX });
  if (hunks === null) {
    throw invalid(
      `not proposed: more than ${PROPOSAL_CHANGED_LINES_MAX} changed lines (removed + added) — propose a small change, with every unchanged line of the file byte for byte (never re-serialised)`,
      'proposal.scenario_yaml',
    );
  }
  if (hunks.length === 0) throw invalid(`not proposed: the text differs from ${today.file} only by its line breaks — nothing to propose`, 'proposal.scenario_yaml');
  // Critique B10: a line the person cannot read whole is never removed or changed by a proposal.
  for (const h of hunks) {
    for (const [j, l] of h.del.entries()) {
      const p = proposalLineProblem(l);
      if (p) {
        throw new EngineError('refused', `not proposed: line ${h.at + j} of ${today.file} ${p.startsWith('it holds ') ? p.slice('it '.length) : `is ${p}`} — a proposal never removes or changes such a line: the person changes it in their editor`, {
          details: { line: h.at + j },
        });
      }
    }
  }
  const problem = proposalHunksProblem(hunks) ?? proposalRowsProblem(diffRows(baseLines, hunks).rows.length);
  if (problem) throw invalid(`not proposed: ${problem}`, 'proposal.scenario_yaml');
  // Self-check: the hunks rebuild exactly the bytes checked and stored (never a wrong diff stored).
  if (joinLines(applyHunks(baseLines, hunks), eol) !== text) throw new EngineError('internal', 'not proposed: the line diff does not rebuild the text (a bug): nothing stored');
  const warnings = await checkProposedText(project, scenario, today, text, 'proposed', o);
  const parsed = CommentProposalSchema.safeParse({ base_sha256: today.hash, result_sha256: sha256Hex(text), eol: eol === '\r\n' ? 'crlf' : 'lf', delta: 'edit', hunks });
  if (!parsed.success) throw invalid(`not proposed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'proposal.scenario_yaml');
  return { proposal: parsed.data, warnings };
}

/**
 * The exact bytes a stored proposal writes, rebuilt from today's file (critique B1): the file must be its base (else
 * `conflict`: ask Claude to propose again), the hunks must apply line for line, the result must have the stored hash
 * and the hunks must be the canonical diff of it (else `refused`: a thread file edited by hand).
 */
export function rebuildProposal(today: ScenarioText, p: CommentProposal, stage: Stage): string {
  if (today.hash !== p.base_sha256) {
    throw new EngineError('conflict', `not ${stage}: ${today.file} changed since this was proposed — ask Claude to propose again on today's file`, { details: { current: today.hash } });
  }
  const eol = fileEol(today, stage);
  if ((eol === '\r\n' ? 'crlf' : 'lf') !== p.eol) throw new EngineError('refused', `not ${stage}: the proposal's line breaks are not the file's (a thread file edited by hand?)`);
  const tampered = (why: string) => new EngineError('refused', `not ${stage}: the stored proposal ${why} (a thread file edited by hand?) — ask Claude to propose again`);
  const base = textLines(today.yaml);
  let lines: string[];
  try {
    lines = applyHunks(base, p.hunks);
  } catch (e) {
    throw tampered(`does not apply to the file it names (${(e as Error).message})`);
  }
  const text = joinLines(lines, eol);
  if (sha256Hex(text) !== p.result_sha256) throw tampered('does not give the text it names (its result hash)');
  const canonical = diffLines(base, lines, { maxChanged: PROPOSAL_CHANGED_LINES_MAX });
  if (!canonical || !sameHunks(canonical, p.hunks)) throw tampered('is not the canonical line diff of its text');
  const rows = proposalRowsProblem(diffRows(base, p.hunks).rows.length);
  if (rows) throw tampered(`is too long to be read whole: ${rows}`);
  return text;
}
