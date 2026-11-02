/**
 * L5.12a: Edit's status bar (R4-Edit; R-UI-45; lead decisions H2 / M6) — the screen fills the shell's actions slot:
 * - what is on screen (`timeline-source`), in plain words (review B-L3: no tag there): today's edit of take <run> (with
 *   what changed since the take), the take as captured, or the edit Claude proposed (not written);
 * - the render line (`render-status`, polite): a render of the scenario queued or running (its words and progress, with
 *   Cancel — Stop is for runs only), else the newest render ended without a video ("v4 failed"), else the latest render:
 *   its version, its review's verdict and whether it shows this version ("from this version"), with a link to its Review
 *   report — a render this tab queued says so once its review is written ("reviewed: … · Open the review");
 * - Undo · Redo of the switches (naming the edit; ⌘Z / ⇧⌘Z outside a field) and Render — Edit owns the Scenario menu's
 *   Render at the screen's priority (⌘B and the palette are this button): the capture and the file AS SHOWN, through
 *   useRenders (a file changed since is refused and the view read again; one render of a scenario at a time), "Render
 *   the take as captured" on such a take, and off with why on a proposal (⌘B there renders nothing: the proposal is not
 *   the file on disk).
 */
import type { ScenarioRendersView } from '@demo-studio/engine';
import { Txt } from './bits.js';
import { busyWhy, failedWords } from './Renders.js';
import type { RenderTarget, RendersState } from './Renders.js';
import { hasReport, jobWords, reviewBadge, versionNote, versionWords } from './render-words.js';
import type { ShownVersion } from './render-words.js';
import type { SwitchEditor } from './TimelineInspector.js';
import { Button, LinkButton, Progress } from './ui-kit/index.js';

export interface EditSource {
  proposal: boolean;
  edit: 'scenario' | 'run';
  run: string;
  changes?: string[];
}

/** Why Edit's Render is off now (the target's reason, a render already going), or null. */
export function renderOff(r: RendersState, target: RenderTarget): string | null {
  return 'why' in target ? target.why : busyWhy(r);
}

/** The render line's words (the polite region holds text only: its links follow it). */
function RenderLine({ v, shown, mine }: { v: ScenarioRendersView; shown: ShownVersion; mine: ReadonlySet<string> }) {
  const latest = v.renders[0];
  if (v.last_failed) {
    return (
      <span data-testid="render-bar-failed">
        <Txt text={`${versionWords(v.last_failed.render_id)} ${failedWords(v.last_failed.state)} — why: in the Review report`} />
        {latest ? <Txt className="ed-quiet" text={` · latest video ${versionWords(latest.render_id)}`} /> : null}
      </span>
    );
  }
  if (!latest) return <span className="ed-quiet">renders this capture with the theme of the files, then reviews it</span>;
  const b = reviewBadge(latest.review);
  const reviewed = mine.has(latest.render_id) && hasReport(latest.review);
  return <Txt text={`${reviewed ? `${versionWords(latest.render_id)} reviewed` : `Latest: ${versionWords(latest.render_id)}`} · ${b.words} · ${versionNote(latest, shown).words}`} />;
}

/** The link after the render line: the Review report of the latest render (or of the failure's scenario). */
function ReviewLink({ v, mine, slug, name }: { v: ScenarioRendersView; mine: ReadonlySet<string>; slug: string; name: string }) {
  const latest = v.renders[0];
  if (v.last_failed || !latest) {
    return v.last_failed ? (
      <LinkButton size="sm" variant="ghost" to={{ name: 'review', slug, scenario: name }} testId="render-open-review">
        Review report
      </LinkButton>
    ) : null;
  }
  if (!hasReport(latest.review)) return null;
  return (
    <LinkButton size="sm" variant="ghost" to={{ name: 'review', slug, scenario: name, render: latest.render_id }} testId="render-open-review">
      {mine.has(latest.render_id) ? 'Open the review' : 'Review'}
    </LinkButton>
  );
}

export function EditStatus({ slug, name, source, r, target, shown, ed, inApp }: { slug: string; name: string; source: EditSource; r: RendersState; target: RenderTarget; shown: ShownVersion; ed: SwitchEditor; inApp: boolean }) {
  const v = r.loaded.state === 'ready' ? r.loaded.data : null;
  const job = v?.jobs[0];
  const off = renderOff(r, target);
  const label = r.sending ? 'Starting the render…' : 'why' in target || !target.asCaptured ? 'Render' : 'Render the take as captured';
  const stopping = job ? job.cancel_requested || r.cancelling.has(job.id) : false;
  return (
    <>
      <span className="sh-scenario ed-status" data-testid="edit-state">
        <span className="ed-status-seg ed-status-source" data-testid="timeline-source">
          {source.proposal ? (
            'The edit Claude proposed, on the take its comment was made on — not written'
          ) : source.edit === 'scenario' ? (
            <>
              {"Today's edit of take "}
              <Txt className="k-mono" text={source.run} />
              {source.changes?.length ? (
                <>
                  {' — changed since the take: '}
                  <Txt text={source.changes.join(', ')} />
                </>
              ) : null}
            </>
          ) : (
            'The take as it was captured'
          )}
        </span>
        <span className="ed-status-sep" aria-hidden="true">
          {' · '}
        </span>
        <span className="ed-status-seg" role="status" aria-live="polite" data-testid="render-status">
          {job ? (
            <span data-testid="render-job" data-state={job.reviewing ? 'reviewing' : job.state} data-id={job.render_id}>
              <Txt text={jobWords(job)} />
            </span>
          ) : v ? (
            <RenderLine v={v} shown={shown} mine={r.mine} />
          ) : null}
        </span>
        {!job && v && <ReviewLink v={v} mine={r.mine} slug={slug} name={name} />}
      </span>
      {job && job.state === 'running' && !job.reviewing && <Progress label={`${versionWords(job.render_id)} rendered`} value={Math.round((job.fraction ?? 0) * 100)} testId="render-progress" />}
      {job && (
        <Button size="sm" variant="ghost" data-testid="render-cancel" disabled={stopping} onClick={() => r.cancel(job.id)}>
          {stopping ? 'Stopping…' : job.reviewing ? 'Stop the review' : 'Cancel the render'}
        </Button>
      )}
      <Button size="sm" variant="ghost" icon="undo" data-testid="tl-undo" disabled={!ed.enabled || ed.undoLabel === null} aria-keyshortcuts="Meta+Z Control+Z" aria-describedby="ed-undo-what" onClick={ed.undo}>
        Undo
      </Button>
      <Button size="sm" variant="ghost" icon="redo" data-testid="tl-redo" disabled={!ed.enabled || ed.redoLabel === null} aria-keyshortcuts="Shift+Meta+Z Shift+Control+Z Control+Y" aria-describedby="ed-redo-what" onClick={ed.redo}>
        Redo
      </Button>
      <span className="k-sr">
        <span id="ed-undo-what">
          <Txt text={ed.undoLabel ? `Undo: ${ed.undoLabel}` : 'Nothing to undo'} />
        </span>
        <span id="ed-redo-what">
          <Txt text={ed.redoLabel ? `Redo: ${ed.redoLabel}` : 'Nothing to redo'} />
        </span>
        <span id="ed-render-why">
          <Txt text={off ? `Render: ${off}` : `Render the capture ${'why' in target ? '' : target.run} of ${name} with the file as shown`} />
        </span>
      </span>
      <Button size="sm" variant="primary" data-testid="render" disabled={off !== null || r.sending} aria-describedby="ed-render-why" kbd={inApp ? ['⌘', 'B'] : undefined} onClick={() => !('why' in target) && r.render(target)}>
        <Txt text={label} />
      </Button>
    </>
  );
}
