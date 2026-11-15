/**
 * The report's head and first sections as they are drawn: the render's facts, what the review found and the render
 * picker; a review not written yet (or failed, or never asked); and the review's contact sheets, asked one at a time.
 */
import { useEffect, useState } from 'react';
import type { ScenarioRenderView } from '@retake/engine';
import type { RenderReviewAnswer } from '../../server/ops.js';
import { errorText } from '../api.js';
import { reviewImage } from '../data/renders.js';
import type { StillAnswer } from '../data/ops.js';
import { Txt, When } from '../bits.js';
import { TONE_MARK } from './Renders.js';
import { reviewBadge, versionNote, versionWords } from '../words/render-words.js';
import { agoWords, clockWords, countWords, shortTime } from './review-words.js';
import { hrefTo } from '../route.js';
import { SessionEnded } from '../session.js';
import { Jpeg } from '../Thumb.js';
import { SHEET_DATA_MAX } from '../thumbs.js';
import { Callout, ContactSheet, Progress, Select, StatusMark } from '../ui-kit/index.js';
import type { ContactSheetItem } from '../ui-kit/index.js';

/** The report's head: the scenario and version, the render's facts, what the review found, the render picker. */
export function ReportHead({
  slug,
  name,
  x,
  renders,
  review,
  shown,
  clash,
}: {
  slug: string;
  name: string;
  x: ScenarioRenderView;
  renders: ScenarioRenderView[];
  review: RenderReviewAnswer | null;
  shown: { run?: string; hash?: string };
  clash: ReadonlySet<string>;
}) {
  const b = reviewBadge(x.review);
  return (
    <header className="rv-head">
      <div className="rv-head-text">
        <h1 className="rv-h1">
          <Txt text={name} />
          <Txt className="rv-h1-version" text={` · ${versionWords(x.render_id)}`} />
        </h1>
        <p className="rv-facts">
          {x.status === 'succeeded' ? (
            <>
              {'rendered '}
              <When iso={x.created_at} />
              <Txt text={` · ${x.width}×${x.height} · ${shortTime(x.duration_s)} · ${x.fps} fps · theme `} />
              <Txt text={x.theme} />
              <Txt text={` · ${versionNote(x, shown).words}`} />
            </>
          ) : (
            <StatusMark state="fail" word={`${versionWords(x.render_id)} ${x.status}: no video`} />
          )}
        </p>
        <p className="rv-verdict" data-testid="review-verdict">
          <StatusMark state={TONE_MARK[b.tone]} word={review?.counts ? countWords(review.counts) : b.words} />
          {review?.fps ? <Txt text={` · contact sheets at ${review.fps} fps`} /> : null}
        </p>
      </div>
      <Select
        layout="inline"
        label="Render"
        testId="review-render-picker"
        value={x.render_id}
        options={renders.map((o) => ({
          value: o.render_id,
          label: `${versionWords(o.render_id)} · ${agoWords(o.created_at)}${clash.has(o.render_id) ? ` ${clockWords(o.created_at)}` : ''}${o.status !== 'succeeded' ? ` · ${o.status}` : ''}`,
        }))}
        onChange={(id) => {
          location.hash = hrefTo({ name: 'review', slug, scenario: name, render: id });
        }}
      />
    </header>
  );
}

/** A review not written yet (queued, running with its progress), failed (its message), or never asked (its job's state). */
export function ReviewPending({ review, reviewing }: { review: RenderReviewAnswer; reviewing: number | undefined }) {
  const state = review.status;
  if (state === 'queued' || state === 'running' || reviewing !== undefined) {
    const f = review.job?.progress?.fraction ?? reviewing;
    return (
      <div className="rv-pending" data-testid="review-running">
        <Progress label="Reviewing the render" {...(f !== undefined ? { value: Math.round(f * 100) } : {})} />
      </div>
    );
  }
  if (state === 'failed' || state === 'cancelled' || state === 'interrupted') {
    return (
      <Callout
        state="fail"
        role="note"
        title={state === 'cancelled' ? 'The review was cancelled' : state === 'interrupted' ? 'The review was interrupted' : 'The review failed'}
        testId="review-failed"
      >
        {review.untrusted.error && (
          <p className="rv-pre">
            <Txt text={review.untrusted.error} />
          </p>
        )}
      </Callout>
    );
  }
  return (
    <Callout state="idle" role="note" title="Note: this render has no review" testId="review-none">
      A render from the Studio reviews itself; one rendered elsewhere is reviewed with retake review.
    </Callout>
  );
}

export type SheetState = { s: 'waiting' } | { s: 'ok'; a: StillAnswer } | { s: 'error'; message: string };

/** The review's sheets, asked one at a time (the next once the one before answered), each a figure of the ContactSheet. */
export function Sheets({ slug, renderId, images, labelledBy }: { slug: string; renderId: string; images: RenderReviewAnswer['images']; labelledBy: string }) {
  const [states, setStates] = useState<Record<string, SheetState>>({});
  const [next, setNext] = useState(0);
  useEffect(() => {
    if (next >= images.length) return;
    const img = images[next];
    const ac = new AbortController();
    reviewImage({ project: slug, render_id: renderId, image: img.image }, { signal: ac.signal }).then(
      (a) => {
        setStates((s) => ({ ...s, [img.image]: { s: 'ok', a } }));
        setNext((n) => n + 1);
      },
      (e: unknown) => {
        if (ac.signal.aborted || e instanceof SessionEnded) return;
        setStates((s) => ({ ...s, [img.image]: { s: 'error', message: errorText(e) } }));
        setNext((n) => n + 1);
      },
    );
    return () => ac.abort();
  }, [next, images, slug, renderId]);
  const items: ContactSheetItem[] = images.map((img) => {
    const st = states[img.image] ?? { s: 'waiting' };
    return {
      key: img.image,
      name: img.label,
      label: <Txt text={img.label} />,
      state: st.s,
      testId: 'review-sheet',
      picture: st.s === 'ok' ? <Jpeg base64={st.a.base64} max={SHEET_DATA_MAX} width={st.a.width} height={st.a.height} alt={`${img.label} of ${versionWords(renderId)}`} /> : null,
      words: st.s === 'error' ? <Txt text={st.message} /> : 'Loading the contact sheet…',
    };
  });
  return <ContactSheet labelledBy={labelledBy} items={items} testId="review-sheets" />;
}
