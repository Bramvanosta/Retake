/**
 * Claude's proposal in the thread (L4.6 part D2; R-UI-28; L5.12b « Épure » 4b on the kit, R-UI-47 — was ProposalPanel.tsx):
 *
 * - The diff (the kit's DiffTable): the rows the server computed — the canonical diff of the exact bytes Apply writes,
 *   with context, rebuilt from today's file — each a sign and its word, the line numbers before and after, the line drawn
 *   code-safe (comment-words linePieces: byte order left to right, a line holding right-to-left letters marked so, edge
 *   spaces `·`, tabs `→`, every unseen character `[U+…]`). The summary is read first; past 25 % of the file a rewrite
 *   note. Every row is shown, in the pane's own scroll (no inner box, no "Show all": the server refuses a diff of more
 *   than PROPOSAL_ROWS_MAX rows), and Apply comes after the whole diff. A proposal whose file is neither its base nor its
 *   result shows its stored lines, said so.
 * - The buttons come from the server's `offer` ONLY (proposalButtons): Apply, Preview change (the timeline on the
 *   proposed edit, nothing written), Apply and re-render; what is not offered is said with the server's `why`. The page
 *   never makes a proposal (thread_reply takes none: proposals are Claude's, from the MCP).
 * - Apply: thread_apply on the proposal's hash shown; Apply and re-render: thread_apply, then scenario_render of the
 *   thread's take on the exact file the apply wrote (expect_edit_sha256 = the answer's hash), its progress, then
 *   "Resolve with vN". Undo apply (while today's file is the one the apply wrote): scenario_edit `restore` of the
 *   answer's `previous` on that hash — the proposal then reads "Applied, then undone" and is offered again.
 * - After an apply, its problems and the scenario's warnings are said.
 * - The last apply of each thread is kept for this tab (the apply store: a reload loses Undo apply). The timeline's
 *   banner (ProposalBanner.tsx) never applies: Back to the comment opens the thread scrolled to its proposal — a one-shot
 * hand-off (proposal-focus.ts), dropped when the address goes anywhere but that thread or the thread cannot be read.
 * Every text from the server is a text node (Txt, a kit slot, or the pieces of a diff line): nothing is ever HTML.
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ProposalAnswer, ThreadAnswer, ThreadApplyAnswer } from '../../server/comment-ops.js';
import { CallError, errorText } from '../api.js';
import { threadApply, threadResolve } from '../data/comments.js';
import { scenarioRender } from '../data/renders.js';
import { scenarioEdit } from '../data/scenarios.js';
import { Txt, shown } from '../bits.js';
import type { RendersState } from './Renders.js';
import { jobWords, versionWords } from '../words/render-words.js';
import { takeProposalFocus } from './proposal-focus.js';
import { SessionEnded } from '../session.js';
import { appliedWords, canUndo, diffRowsView, proposalButtons, proposalSummary, proposalWords, renderAfterApplyArgs, rewriteNote, undoEditArgs } from '../words/comment-words.js';
import type { ProposalButton } from '../words/comment-words.js';
import { Button, Callout, DiffTable, LinkButton, Progress, StatusMark } from '../ui-kit/index.js';
import type { MarkState } from '../ui-kit/index.js';

// ── The last apply of each thread, for this tab ─────────────────────────────

type RenderAsk = { state: 'sending' } | { state: 'queued'; render_id: string } | { state: 'refused'; message: string };

export interface ApplyRecord {
  answer: ThreadApplyAnswer;
  render?: RenderAsk;
  undone?: boolean;
}

const records = new Map<string, ApplyRecord>();
const listeners = new Set<() => void>();
const recordKey = (slug: string, id: string) => `${slug}\0${id}`;

function setRecord(slug: string, id: string, r: ApplyRecord): void {
  records.set(recordKey(slug, id), r);
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The thread's last apply in this tab (re-rendered when it changes). */
function useApplyRecord(slug: string, id: string): ApplyRecord | undefined {
  return useSyncExternalStore(subscribe, () => records.get(recordKey(slug, id)));
}

export type ApplyOutcome = { ok: true; record: ApplyRecord } | { ok: false; conflict: boolean; message: string };

/**
 * Apply a thread's proposal (thread_apply on the proposal's hash shown) and, with `runId`, render the thread's take on the
 * file it wrote (scenario_render, expect_edit_sha256 = the apply's hash: a file changed in between is refused).
 */
async function applyProposal(slug: string, threadId: string, entryId: string, ifMatch: string, runId: string | null): Promise<ApplyOutcome> {
  let answer: ThreadApplyAnswer;
  try {
    answer = await threadApply({ project: slug, comment_id: threadId, entry_id: entryId, if_match: ifMatch });
  } catch (e) {
    if (e instanceof SessionEnded) throw e;
    const conflict = e instanceof CallError && e.status === 409;
    return { ok: false, conflict, message: conflict ? `The thread or the scenario changed since you opened it: read it again — nothing was written. (${errorText(e)})` : errorText(e) };
  }
  if (runId === null) {
    const record: ApplyRecord = { answer };
    setRecord(slug, threadId, record);
    return { ok: true, record };
  }
  setRecord(slug, threadId, { answer, render: { state: 'sending' } });
  let render: RenderAsk;
  try {
    const d = await scenarioRender(renderAfterApplyArgs(slug, answer, runId));
    render = { state: 'queued', render_id: d.render_id };
  } catch (e) {
    if (e instanceof SessionEnded) throw e;
    render = { state: 'refused', message: errorText(e) };
  }
  const record: ApplyRecord = { answer, render };
  setRecord(slug, threadId, record);
  return { ok: true, record };
}

// ── The proposal in the thread ──────────────────────────────────────────────

const BUTTON_WORDS: Record<ProposalButton, string> = { apply: 'Apply', preview: 'Preview change', apply_render: 'Apply and re-render' };

type Busy = null | 'apply' | 'apply_render' | 'undo' | 'resolve';
type Said = { state: MarkState; title: string; words: string };

/** The proposal's state as a mark: one that can still be applied asks for attention. */
const proposalMark = (actionable: boolean): MarkState => (actionable ? 'warn' : 'idle');

/** The first line the diff touches ("line 104"), for its head. */
function firstLine(p: Pick<ProposalAnswer, 'rows'>): number | null {
  for (const r of p.rows) {
    if (r.kind === 'add' && typeof r.line === 'number') return r.line;
    if (r.kind === 'del' && typeof r.base === 'number') return r.base;
  }
  return null;
}

/** The thread's newest proposal: summary, diff, the offered buttons, Undo apply, the render after it and Resolve with vN. */
export function ProposalCard({ slug, name, th, p, rs, reload }: { slug: string; name: string; th: ThreadAnswer; p: ProposalAnswer; rs: RendersState; reload: () => void }) {
  const record = useApplyRecord(slug, th.id);
  const [busy, setBusy] = useState<Busy>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const head = useId();
  const card = useRef<HTMLElement>(null);
  // Opened from the timeline's Back to the comment: the proposal is scrolled into view and its heading focused.
  useEffect(() => {
    if (!takeProposalFocus(slug, th.id)) return;
    card.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
    card.current?.querySelector<HTMLElement>('[data-testid="proposal-head"]')?.focus({ preventScroll: true });
  }, [slug, th.id]);
  const { buttons, why } = proposalButtons(p.offer);
  const note = rewriteNote(p.rewrites_pct);
  const reloadRenders = rs.reload;
  const line = firstLine(p);
  // The diff's rows drawn once per proposal read (review A-L2), not on every render of the card.
  const rows = useMemo(() => diffRowsView(p.rows, p.untrusted.rows), [p.rows, p.untrusted.rows]);

  const apply = (render: boolean) => {
    setBusy(render ? 'apply_render' : 'apply');
    setSaid(null);
    applyProposal(slug, th.id, p.entry, p.hash, render ? th.run_id : null)
      .then(
        (o) => {
          if (!o.ok) setSaid({ state: o.conflict ? 'warn' : 'fail', title: o.conflict ? 'Not applied: the thread changed' : 'Not applied', words: o.message });
          else {
            // What the apply said beside the write: its problems, the scenario's warnings.
            const after = appliedWords(o.record.answer);
            if (o.record.render?.state === 'refused')
              setSaid({ state: 'fail', title: 'Applied, the render failed to start', words: `Applied, but the render was not started: ${o.record.render.message}${after ? `\n${after.words}` : ''}` });
            else if (after) setSaid({ state: 'warn', title: 'Applied, with a warning', words: after.words });
          }
          if (render) reloadRenders();
        },
        () => undefined,
      )
      .finally(() => {
        setBusy(null);
        reload();
      });
  };
  const undo = () => {
    if (!record) return;
    setBusy('undo');
    setSaid(null);
    scenarioEdit(undoEditArgs(slug, record.answer))
      .then(
        () => setRecord(slug, th.id, { ...record, undone: true }),
        (e: unknown) => {
          if (e instanceof SessionEnded) return;
          setSaid({ state: e instanceof CallError && e.status === 409 ? 'warn' : 'fail', title: 'Not undone', words: `Not undone: ${errorText(e)}` });
        },
      )
      .finally(() => {
        setBusy(null);
        reload();
      });
  };

  // The render the apply queued: its job, then the render once written (succeeded), or its failure.
  const asked = record && !record.undone && record.answer.scenario.hash === p.today_sha256 ? record.render : undefined;
  const rid = asked?.state === 'queued' ? asked.render_id : null;
  const rv = rs.loaded.state === 'ready' ? rs.loaded.data : null;
  const job = rid && rv ? rv.jobs.find((j) => j.render_id === rid) : undefined;
  const done = rid && rv ? rv.renders.find((r) => r.render_id === rid && r.status === 'succeeded') : undefined;
  const failed = rid && rv && !job && !done && rv.last_failed?.render_id === rid ? rv.last_failed : undefined;
  const resolveWith = (renderId: string) => {
    setBusy('resolve');
    setSaid(null);
    threadResolve({ project: slug, comment_id: th.id, note: `Applied the proposal ${p.entry} and rendered ${versionWords(renderId)}.`, render_id: renderId, if_match: th.hash })
      .then(
        () => setSaid({ state: 'ok', title: `Resolved with ${versionWords(renderId)}`, words: `Resolved with ${versionWords(renderId)}` }),
        (e: unknown) => {
          if (e instanceof SessionEnded) return;
          setSaid({ state: e instanceof CallError && e.status === 409 ? 'warn' : 'fail', title: 'Not resolved', words: `Not resolved: ${errorText(e)}` });
        },
      )
      .finally(() => {
        setBusy(null);
        reload();
      });
  };

  return (
    <section ref={card} className="cm-proposal" aria-labelledby={head} data-testid="proposal" data-state={p.state} data-verified={p.verified ? 'yes' : 'no'} data-entry={p.entry}>
      <div className="cm-proposal-head">
        <h3 id={head} className="cm-h3" tabIndex={-1} data-testid="proposal-head">
          Claude's proposal
        </h3>
        <StatusMark state={proposalMark(p.actionable)} word={proposalWords(p.state)} />
      </div>
      <p className="cm-small" data-testid="proposal-summary">
        {'A change to the scenario file '}
        <Txt className="k-mono" text={name} />
        <Txt text={`: ${proposalSummary(p)}.`} />
      </p>
      {note && (
        <Callout state="warn" role="note" title="Warning: a rewrite">
          <p data-testid="proposal-rewrite">
            <Txt text={note} />
          </p>
        </Callout>
      )}
      {!p.verified && (
        <p className="cm-quiet" data-testid="proposal-unverified">
          Today's file is neither the one this was proposed on nor the one it makes: these are its lines as stored, without context.
        </p>
      )}
      <DiffTable
        rows={rows}
        label="The proposed change, line by line"
        title={<Txt text={`scenarios/${name}.yaml${line !== null ? ` · line ${line.toLocaleString('en')}` : ''}`} />}
        testId="proposal-diff"
        boxTestId="proposal-diff-box"
      />
      {buttons.length > 0 && (
        <div className="cm-actions" role="group" aria-label="The proposal">
          {buttons.map((b) =>
            b === 'preview' ? (
              <LinkButton key={b} size="sm" testId="proposal-preview" to={{ name: 'proposal', slug, scenario: name, thread: th.id, entry: p.entry }}>
                {shown(BUTTON_WORDS[b])}
              </LinkButton>
            ) : (
              <Button
                key={b}
                size="sm"
                variant={b === 'apply_render' ? 'primary' : 'secondary'}
                data-testid={b === 'apply' ? 'proposal-apply' : 'proposal-apply-render'}
                disabled={busy !== null}
                onClick={() => apply(b === 'apply_render')}
              >
                {shown(busy === b ? (b === 'apply' ? 'Applying…' : 'Applying, then rendering…') : BUTTON_WORDS[b])}
              </Button>
            ),
          )}
        </div>
      )}
      {why && (
        <p className="cm-quiet" data-testid="proposal-why">
          <Txt text={`${why}.`} />
        </p>
      )}
      <div aria-live="polite" className="cm-after">
        {record && !record.undone && th.status === 'open' && canUndo(record.answer, p.today_sha256) && (
          <p className="cm-line" data-testid="proposal-applied">
            {'Applied from this page. '}
            <Button size="sm" data-testid="proposal-undo" disabled={busy !== null} onClick={undo}>
              {busy === 'undo' ? 'Undoing…' : 'Undo apply'}
            </Button>
          </p>
        )}
        {record?.undone && p.state === 'undone' && (
          <p className="cm-small" data-testid="proposal-undone">
            Undone: the scenario file is back to what it was before the apply.
          </p>
        )}
        {asked?.state === 'sending' && <p className="cm-small">Starting the render…</p>}
        {job && !done && (
          <div className="cm-small" data-testid="proposal-render" data-state={job.state}>
            {job.fraction !== undefined && job.state === 'running' && !job.reviewing ? (
              <Progress label={<Txt text={jobWords(job)} />} value={Math.round(job.fraction * 100)} valueText={`${Math.round(job.fraction * 100)} %`} />
            ) : (
              <Txt text={jobWords(job)} />
            )}
          </div>
        )}
        {rid && !job && !done && !failed && (
          <p className="cm-quiet">
            <Txt text={`${versionWords(rid)} is queued…`} />
          </p>
        )}
        {failed && (
          <p className="cm-small" data-testid="proposal-render-failed">
            <Txt text={`${versionWords(failed.render_id)} ended without a video (${failed.state}): its reason is in the Review report's Renders.`} />
          </p>
        )}
        {done && (
          <p className="cm-line" data-testid="proposal-rendered">
            <Txt text={`${versionWords(done.render_id)} is rendered from the applied file${job ? ' (its review is still running)' : ''}. `} />
            {th.status === 'open' && (
              <Button size="sm" variant="primary" data-testid="resolve-with" data-render={done.render_id} disabled={busy !== null} onClick={() => resolveWith(done.render_id)}>
                {shown(busy === 'resolve' ? 'Resolving…' : `Resolve with ${versionWords(done.render_id)}`)}
              </Button>
            )}
          </p>
        )}
      </div>
      {said &&
        (said.state === 'ok' ? (
          <Callout state="ok" role="status" title={said.title}>
            <p className="cm-pre" data-testid="proposal-said">
              <Txt text={said.words} />
            </p>
          </Callout>
        ) : (
          <Callout state={said.state} role="alert" title={said.title}>
            <p className="cm-pre" data-testid="proposal-said">
              <Txt text={said.words} />
            </p>
          </Callout>
        ))}
    </section>
  );
}
