/**
 * Review's chrome, shared by its two views (the report and the comments): the View in the title bar (Report · Comments
 * (n open)), the scenario's thread counts, and the status bar's line with Open in Edit and Render (useReviewRender: the
 * screen owns ⌘B at its priority).
 */
import { useMemo } from 'react';
import type { ScenarioRenderView } from '@retake/engine';
import { useThreadsCounts } from '../data/comments.js';
import { Txt, When } from '../bits.js';
import { commentsEventAction, useEvents } from '../events.js';
import { useProjectView } from '../project-data.js';
import { busyWhy } from './Renders.js';
import type { RenderTarget, RendersState } from './Renders.js';
import { versionWords } from '../words/render-words.js';
import { useRunLocation } from '../shoot/run-location.js';
import { PRIORITY, useShellCommand } from '../shell/command-bus.js';
import { say } from '../shell/say.js';
import { ShellSlot } from '../shell/slots.js';
import { useScenarioActions } from '../shoot/shoot-data.js';
import { Button, LinkButton, SegmentedLinks, StatusMark, studioShell } from '../ui-kit/index.js';

/** A scenario's thread counts (Review's View and its status line), read again on its comments' events; null while read. */
export function useThreadCounts(slug: string, name: string): { open: number; resolved: number } | null {
  const [counts, reload] = useThreadsCounts({ project: slug, name }, `${slug}\0${name}`);
  useEvents((e) => {
    if (commentsEventAction(e, slug, name).threads) reload();
  });
  return counts.state === 'ready' ? (counts.data.scenarios[name] ?? { open: 0, resolved: 0 }) : null;
}

/** Review's View (the title bar's context, on the report and on the comments): Report · Comments (n open). */
export function ReviewViews({ slug, name, current, open }: { slug: string; name: string; current: 'report' | 'comments'; open: number | null }) {
  return (
    <SegmentedLinks
      label="View"
      items={[
        { key: 'report', label: 'Report', to: { name: 'review', slug, scenario: name }, current: current === 'report' },
        // The Comments segment carries the old tab's test id and its count ("Comments (1 open)") on both views.
        { key: 'comments', label: open === null ? 'Comments' : `Comments (${open} open)`, to: { name: 'comments', slug, scenario: name }, current: current === 'comments', testId: 'comments-tab' },
      ]}
    />
  );
}

/** Render from Review: the latest capture with the file on disk, through useRenders (its refusals; one at a time). */
export interface ReviewRender {
  renders: RendersState;
  /** Why Render is off, or null. */
  off: string | null;
  renderNow: () => void;
  /** The capture and file Render would use (for the queue's "shown" words). */
  shown: { run?: string; hash?: string };
}

/**
 * Review's Render (both views: the report and the comments) — the status bar's read of the scenario's actions (one shared
 * entry, no second read); the screen owns ⌘B at its priority.
 */
export function useReviewRender(slug: string, name: string, renders: RendersState): ReviewRender {
  const project = useProjectView(slug);
  const loc = useRunLocation(slug, name, project.state === 'ready' ? project.data.environments : null);
  const actions = useScenarioActions(slug, name, loc.sent);
  const a = actions.state === 'ready' ? actions.data : null;
  const target: RenderTarget = !a ? { why: 'loading the scenario' } : !a.capture ? { why: 'no finished capture yet: a capture films the take a render edits' } : { run: a.capture.id, hash: a.hash };
  const renderNow = () => {
    const off = 'why' in target ? target.why : busyWhy(renders);
    if (off !== null || 'why' in target) return say(`Render of ${name}: ${off ?? 'not ready'}`);
    if (!renders.sending) renders.render(target);
  };
  useShellCommand('render', renderNow, PRIORITY.screen);
  const off = 'why' in target ? target.why : busyWhy(renders);
  return { renders, off, renderNow, shown: { ...(a?.capture ? { run: a.capture.id } : {}), ...(a ? { hash: a.hash } : {}) } };
}

/**
 * Review's chrome, one for both views — the View in the title bar and the status bar's line:
 * "Rendered · when · vN · n open · n resolved", Open in Edit, Render (the render shown: the report's, or the one the
 * comments' viewer shows). Shoot's actions never show in Review (the slot is claimed; StatusActions also stands down on
 * Review's routes).
 */
export function ReviewChrome({ slug, name, current, x, rr }: { slug: string; name: string; current: 'report' | 'comments'; x: ScenarioRenderView | undefined; rr: ReviewRender }) {
  const counts = useThreadCounts(slug, name);
  const inApp = useMemo(() => studioShell() !== null, []);
  const d = rr.renders.loaded.state === 'ready' ? rr.renders.loaded.data : null;
  return (
    <>
      <ShellSlot name="context">
        <ReviewViews slug={slug} name={name} current={current} open={counts?.open ?? null} />
      </ShellSlot>
      <ShellSlot name="actions">
        <span className="sh-scenario" data-testid="review-state">
          {x && x.status === 'succeeded' ? (
            // What the render did, with a neutral mark — never a verdict beside the review's.
            <StatusMark
              state="idle"
              word={
                <>
                  {'Rendered · '}
                  <When iso={x.created_at} />
                  <Txt text={` · ${versionWords(x.render_id)}`} />
                </>
              }
            />
          ) : x ? (
            <StatusMark state="fail" word={`${versionWords(x.render_id)} ${x.status}`} />
          ) : (
            <StatusMark state="idle" word={d ? 'Not rendered yet' : 'Loading the renders'} />
          )}
          {counts && (
            <span className="sh-seg" data-drop="when" data-testid="review-counts">
              <Txt text={` · ${counts.open} open · ${counts.resolved} resolved`} />
            </span>
          )}
        </span>
        {x && (
          <LinkButton size="sm" variant="ghost" to={{ name: 'timeline', slug, scenario: name, run: x.run_id }} testId="review-open-edit">
            Open in Edit
          </LinkButton>
        )}
        <span id="rv-render-why" className="k-sr">
          <Txt text={rr.off ? `Render: ${rr.off}` : `Render ${name} again: its latest capture with the file on disk, then a review`} />
        </span>
        <Button
          size="sm"
          variant="primary"
          data-testid="render"
          disabled={rr.off !== null || rr.renders.sending}
          aria-describedby="rv-render-why"
          kbd={inApp ? ['⌘', 'B'] : undefined}
          onClick={rr.renderNow}
        >
          {rr.renders.sending ? 'Starting the render…' : d && d.renders.length > 0 ? 'Render again' : 'Render'}
        </Button>
      </ShellSlot>
    </>
  );
}
