/**
 * Claude's proposal in the Studio (L4.6 part D2; R-UI-28; plan D6–D7 as amended by the critique B1–B4, B9, B13):
 *
 * - The diff (ProposalDiff): the rows the server computed — the canonical diff of the exact bytes Apply writes, with
 *   context, rebuilt from today's file — as a table: a "+ added" / "− removed" / "unchanged" word per row (a gutter
 *   sign on screen), the line numbers before and after, and each line drawn code-safe (comment-words linePieces: a
 *   monospace left-to-right cell in byte order — bidi override, a line holding right-to-left letters marked so —, spaces
 *   kept, edge spaces `·`, tabs `→`, every unseen character and every combining mark past the third `[U+…]`). The summary
 *   is read first; past 25 % of the file a rewrite note. Every row is shown, in the page's own scroll (no inner box,
 *   no "Show all": review A M1 — the server refuses a diff of more than PROPOSAL_ROWS_MAX rows), and Apply comes after
 *   the whole diff. A proposal whose file is neither its base nor its result shows its stored lines, said so.
 * - The buttons come from the server's `offer` ONLY (proposalButtons): Apply, Preview change (the timeline on the
 *   proposed edit, nothing written), Apply and re-render; what is not offered is said with the server's `why`. The
 *   page never makes a proposal (thread_reply takes none: proposals are Claude's, from the MCP).
 * - Apply: thread_apply on the thread's hash shown; Apply and re-render: thread_apply, then scenario_render of the
 *   thread's take on the exact file the apply wrote (expect_edit_sha256 = the answer's hash), its progress, then
 *   "Resolve with vN". Undo apply: scenario_edit `restore` of the answer's `previous` on the hash the apply wrote — the
 *   proposal then reads "Applied, then undone" and is offered again.
 * - After an apply, its problems and the scenario's warnings are said (review B M2).
 * - The last apply of each thread is kept for this tab (applyStore: a reload loses Undo apply — review B L5). The
 *   timeline's banner never applies (no diff there): Back to the comment opens the thread scrolled to its proposal.
 * Every text from the server is a React text node (Txt, or the pieces of a line): nothing is ever HTML.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { ProposalAnswer, ThreadAnswer, ThreadApplyAnswer, ThreadGetAnswer } from '../server/comment-ops.js';
import { CallError, call, errorText, useCall } from './api.js';
import { Badge, Notice, Txt } from './bits.js';
import type { RendersState } from './Renders.js';
import { jobWords, versionWords } from './render-words.js';
import { hrefTo } from './route.js';
import { SessionEnded } from './session.js';
import { appliedWords, canUndo, diffRowsView, proposalButtons, proposalSummary, proposalWords, renderAfterApplyArgs, rewriteNote, undoEditArgs } from './comment-words.js';
import type { LinePiece, ProposalButton } from './comment-words.js';

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
export function useApplyRecord(slug: string, id: string): ApplyRecord | undefined {
  return useSyncExternalStore(subscribe, () => records.get(recordKey(slug, id)));
}

export type ApplyOutcome = { ok: true; record: ApplyRecord } | { ok: false; conflict: boolean; message: string };

/**
 * Apply a thread's proposal (thread_apply on the thread's hash shown) and, with `runId`, render the thread's take on the
 * file it wrote (scenario_render, expect_edit_sha256 = the apply's hash: a file changed in between is refused).
 */
export async function applyProposal(slug: string, threadId: string, entryId: string, ifMatch: string, runId: string | null): Promise<ApplyOutcome> {
  let answer: ThreadApplyAnswer;
  try {
    answer = await call<ThreadApplyAnswer>('thread_apply', { project: slug, comment_id: threadId, entry_id: entryId, if_match: ifMatch });
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
    const d = await call<{ render_id: string }>('scenario_render', renderAfterApplyArgs(slug, answer, runId));
    render = { state: 'queued', render_id: d.render_id };
  } catch (e) {
    if (e instanceof SessionEnded) throw e;
    render = { state: 'refused', message: errorText(e) };
  }
  const record: ApplyRecord = { answer, render };
  setRecord(slug, threadId, record);
  return { ok: true, record };
}

// ── The diff ────────────────────────────────────────────────────────────────

/** One line, code-safe: text nodes, and the marks for edge spaces, tabs and unseen characters. */
function LineView({ pieces }: { pieces: LinePiece[] }) {
  return (
    <>
      {pieces.map((p, i) =>
        p.kind === 'text' ? (
          <span key={i}>{p.text}</span>
        ) : p.kind === 'space' ? (
          <span key={i} className="pd-mark" title={p.count === 1 ? 'a space' : `${p.count} spaces`}>
            {'·'.repeat(p.count)}
          </span>
        ) : p.kind === 'tab' ? (
          <span key={i} className="pd-mark" title="a tab">
            →
          </span>
        ) : (
          <span key={i} className="pd-mark pd-char" title="a character you cannot see">
            [{p.code}]
          </span>
        ),
      )}
    </>
  );
}

/** The proposal's rows as a table (the server's rows; their texts under untrusted.rows): every row, never a cut. */
export function ProposalDiff({ p }: { p: Pick<ProposalAnswer, 'rows' | 'untrusted'> }) {
  const shown = diffRowsView(p.rows, p.untrusted.rows);
  return (
    <>
      <div className="pd-box" role="group" aria-label="The proposed change, line by line" data-testid="proposal-diff-box">
        <table className="pd" data-testid="proposal-diff">
          <colgroup>
            <col className="pd-col-sign" />
            <col className="pd-col-n" />
            <col className="pd-col-n" />
            <col />
          </colgroup>
          <thead className="sr-only">
            <tr>
              <th scope="col">Change</th>
              <th scope="col">Line before</th>
              <th scope="col">Line after</th>
              <th scope="col">Text</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) =>
              r.kind === 'gap' ? (
                <tr key={i} className="pd-row is-gap" data-testid="diff-row" data-kind="gap">
                  <td colSpan={4} className="pd-gap">
                    <span aria-hidden="true">⋯ </span>
                    {r.word}
                  </td>
                </tr>
              ) : (
                <tr key={i} className={`pd-row is-${r.kind}`} data-testid="diff-row" data-kind={r.kind}>
                  <td className="pd-sign">
                    <span aria-hidden="true">{r.sign}</span>
                    <span className="sr-only">{r.word}</span>
                  </td>
                  <td className="pd-n">{r.base ?? ''}</td>
                  <td className="pd-n">{r.line ?? ''}</td>
                  <td className="pd-code">
                    {r.rtl && (
                      <span className="pd-rtl" data-testid="diff-rtl" title="Drawn in byte order, left to right: an editor shows right-to-left letters in another order">
                        right-to-left text
                      </span>
                    )}
                    <code dir="ltr" data-testid="diff-line">
                      <LineView pieces={r.pieces} />
                    </code>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

const BUTTON_WORDS: Record<ProposalButton, string> = { apply: 'Apply', preview: 'Preview change', apply_render: 'Apply and re-render' };

// ── The proposal in the thread ──────────────────────────────────────────────

/** The thread whose proposal the next thread screen scrolls to (the timeline's Back to the comment). */
let focusWanted: string | null = null;

/** Ask the thread screen to scroll to the thread's proposal when it opens. */
export function focusProposalOf(threadId: string): void {
  focusWanted = threadId;
}

type Busy = null | 'apply' | 'apply_render' | 'undo' | 'resolve';

/** The thread's newest proposal: summary, diff, the offered buttons, Undo apply, the render after it and Resolve with vN. */
export function ProposalCard({ slug, name, th, p, rs, reload }: { slug: string; name: string; th: ThreadAnswer; p: ProposalAnswer; rs: RendersState; reload: () => void }) {
  const record = useApplyRecord(slug, th.id);
  const [busy, setBusy] = useState<Busy>(null);
  const [said, setSaid] = useState<{ tone: 'info' | 'warning' | 'danger'; words: string } | null>(null);
  const head = useId();
  const card = useRef<HTMLElement>(null);
  // Opened from the timeline's Back to the comment: the proposal is scrolled into view and its heading focused.
  useEffect(() => {
    if (focusWanted !== th.id) return;
    focusWanted = null;
    card.current?.scrollIntoView({ block: 'start' });
    card.current?.querySelector<HTMLElement>('.pp-head')?.focus({ preventScroll: true });
  }, [th.id]);
  const { buttons, why } = proposalButtons(p.offer);
  const note = rewriteNote(p.rewrites_pct);
  const reloadRenders = rs.reload;

  const apply = (render: boolean) => {
    setBusy(render ? 'apply_render' : 'apply');
    setSaid(null);
    applyProposal(slug, th.id, p.entry, p.hash, render ? th.run_id : null)
      .then(
        (o) => {
          if (!o.ok) setSaid({ tone: o.conflict ? 'warning' : 'danger', words: o.message });
          else {
            // What the apply said beside the write (review B M2): its problems, the scenario's warnings.
            const after = appliedWords(o.record.answer);
            if (o.record.render?.state === 'refused') setSaid({ tone: 'danger', words: `Applied, but the render was not started: ${o.record.render.message}${after ? `\n${after.words}` : ''}` });
            else if (after) setSaid(after);
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
    call('scenario_edit', undoEditArgs(slug, record.answer))
      .then(
        () => setRecord(slug, th.id, { ...record, undone: true }),
        (e: unknown) => {
          if (e instanceof SessionEnded) return;
          setSaid({ tone: e instanceof CallError && e.status === 409 ? 'warning' : 'danger', words: `Not undone: ${errorText(e)}` });
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
    call('thread_resolve', { project: slug, comment_id: th.id, note: `Applied the proposal ${p.entry} and rendered ${versionWords(renderId)}.`, render_id: renderId, if_match: th.hash })
      .then(
        () => setSaid({ tone: 'info', words: `Resolved with ${versionWords(renderId)}` }),
        (e: unknown) => {
          if (e instanceof SessionEnded) return;
          setSaid({ tone: e instanceof CallError && e.status === 409 ? 'warning' : 'danger', words: `Not resolved: ${errorText(e)}` });
        },
      )
      .finally(() => {
        setBusy(null);
        reload();
      });
  };

  return (
    <section ref={card} className="pp" aria-labelledby={head} data-testid="proposal" data-state={p.state} data-verified={p.verified ? 'yes' : 'no'} data-entry={p.entry}>
      <h3 id={head} className="card-title pp-head" tabIndex={-1}>
        Claude's proposal <Badge tone={p.actionable ? 'warning' : 'neutral'}>{proposalWords(p.state)}</Badge>
      </h3>
      <p className="small" data-testid="proposal-summary">
        A change to the scenario file <Txt className="mono" text={name} />: {proposalSummary(p)}.
      </p>
      {note && (
        <Notice tone="warning" role="note">
          <p className="small" data-testid="proposal-rewrite">
            {note}
          </p>
        </Notice>
      )}
      {!p.verified && (
        <p className="small muted" data-testid="proposal-unverified">
          Today's file is neither the one this was proposed on nor the one it makes: these are its lines as stored, without context.
        </p>
      )}
      <ProposalDiff p={p} />
      {buttons.length > 0 && (
        <div className="actions pp-actions" role="group" aria-label="The proposal">
          {buttons.map((b) =>
            b === 'preview' ? (
              <a key={b} className="button" data-testid="proposal-preview" href={hrefTo({ name: 'proposal', slug, scenario: name, thread: th.id, entry: p.entry })}>
                {BUTTON_WORDS[b]}
              </a>
            ) : (
              <button key={b} type="button" className={b === 'apply_render' ? 'button primary' : 'button'} data-testid={b === 'apply' ? 'proposal-apply' : 'proposal-apply-render'} disabled={busy !== null} onClick={() => apply(b === 'apply_render')}>
                {busy === b ? (b === 'apply' ? 'Applying…' : 'Applying, then rendering…') : BUTTON_WORDS[b]}
              </button>
            ),
          )}
        </div>
      )}
      {why && (
        <p className="small muted" data-testid="proposal-why">
          <Txt text={why} />.
        </p>
      )}
      <div aria-live="polite" className="pp-after">
        {record && !record.undone && th.status === 'open' && canUndo(record.answer, p.today_sha256) && (
          <p className="small" data-testid="proposal-applied">
            Applied from this page.{' '}
            <button type="button" className="button small" data-testid="proposal-undo" disabled={busy !== null} onClick={undo}>
              {busy === 'undo' ? 'Undoing…' : 'Undo apply'}
            </button>
          </p>
        )}
        {record?.undone && p.state === 'undone' && (
          <p className="small" data-testid="proposal-undone">
            Undone: the scenario file is back to what it was before the apply.
          </p>
        )}
        {asked?.state === 'sending' && <p className="small">Starting the render…</p>}
        {job && !done && (
          <p className="small" data-testid="proposal-render" data-state={job.state}>
            <Txt text={jobWords(job)} />
            {job.fraction !== undefined && job.state === 'running' && !job.reviewing && <progress max={1} value={job.fraction} aria-label={`${versionWords(job.render_id)} rendered`} />}
          </p>
        )}
        {rid && !job && !done && !failed && <p className="small muted">{versionWords(rid)} is queued…</p>}
        {failed && (
          <p className="small" data-testid="proposal-render-failed">
            {versionWords(failed.render_id)} ended without a video ({failed.state}): its reason is under the timeline's Renders.
          </p>
        )}
        {done && (
          <p className="small" data-testid="proposal-rendered">
            {versionWords(done.render_id)} is rendered from the applied file{job ? ' (its review is still running)' : ''}.{' '}
            {th.status === 'open' && (
              <button type="button" className="button small primary" data-testid="resolve-with" data-render={done.render_id} disabled={busy !== null} onClick={() => resolveWith(done.render_id)}>
                {busy === 'resolve' ? 'Resolving…' : `Resolve with ${versionWords(done.render_id)}`}
              </button>
            )}
          </p>
        )}
      </div>
      {said && (
        <Notice tone={said.tone} role={said.tone === 'info' ? 'status' : 'alert'}>
          <p className="pre-line small" data-testid="proposal-said">
            <Txt text={said.words} />
          </p>
        </Notice>
      )}
    </section>
  );
}

// ── The timeline's banner (Preview change) ──────────────────────────────────

/**
 * The banner over the timeline while it previews a proposal (`timeline_view {proposal}`: planned in memory from the
 * proposed text on the commented take, nothing written, switches off): which comment, whether the plan shows the change,
 * and Back to the comment — the thread, scrolled to its proposal. It never applies (review A M1): Apply is offered only
 * where the whole diff is shown.
 */
export function ProposalBanner({ slug, name, proposal, shown }: { slug: string; name: string; proposal: { comment_id: string; entry_id: string }; shown: boolean | undefined }) {
  const [loaded] = useCall<ThreadGetAnswer>('thread_get', { project: slug, comment_id: proposal.comment_id, entry_id: proposal.entry_id }, `${slug}\0${proposal.comment_id}\0${proposal.entry_id}`);
  const data = loaded.state === 'ready' ? loaded.data : null;
  const p = data?.proposal && data.proposal.entry === proposal.entry_id ? data.proposal : null;
  const { why } = proposalButtons(p?.offer);
  return (
    <Notice tone="info" role="note" title="Previewing a proposed change">
      <div data-testid="proposal-banner" data-shown={shown === false ? 'no' : 'yes'}>
        <p className="small">
          {data ? (
            <>
              The edit Claude proposed on the comment at {data.thread.timecode} ({versionWords(data.thread.render_id)}, frame {data.thread.frame.toLocaleString('en')}), planned on its take. Nothing is written here; switches and Render are off. Read the whole diff and apply it in the thread.
            </>
          ) : (
            'The edit Claude proposed on a comment, planned on its take. Nothing is written here: read the whole diff and apply it in the thread.'
          )}
        </p>
        {p && <p className="small">{proposalSummary(p)}.</p>}
        {shown === false && (
          <p className="small" data-testid="proposal-not-shown">
            The preview cannot show this change on this take (the plan comes out as captured): read the diff in the thread instead.
          </p>
        )}
        {loaded.state === 'error' && (
          <p className="pre-line small" role="alert">
            <Txt text={loaded.error} />
          </p>
        )}
        <div className="actions">
          <a className="button small primary" href={hrefTo({ name: 'comments', slug, scenario: name, thread: proposal.comment_id })} data-testid="banner-back" onClick={() => focusProposalOf(proposal.comment_id)}>
            Back to the comment
          </a>
        </div>
        {p && p.offer.apply !== true && why && (
          <p className="small muted" data-testid="banner-why">
            <Txt text={why} />.
          </p>
        )}
      </div>
    </Notice>
  );
}
