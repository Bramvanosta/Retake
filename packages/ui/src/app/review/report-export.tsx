/**
 * The report's Export: Export video (MP4) queues the engine's export job through review_export (one at a time per
 * render; followed in the activity), and the raw capture for an editing tool is a command to copy.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScenarioRenderView } from '@retake/engine';
import { CallError, errorText } from '../api.js';
import { activityList } from '../data/projects.js';
import { reviewExport } from '../data/renders.js';
import { Txt, When } from '../bits.js';
import { useEvents } from '../events.js';
import { failedWords } from './Renders.js';
import { versionWords } from '../words/render-words.js';
import { exportReadsOn, rawExportCommand } from './review-words.js';
import { SessionEnded } from '../session.js';
import { Blocker, Button, Callout } from '../ui-kit/index.js';

type ExportState = { s: 'idle' } | { s: 'sending' } | { s: 'refused'; message: string } | { s: 'job'; job: string; state: string; fraction?: number; at?: string };

/** The newest export of a render in the activity (path-free: ids, kinds, states, times), or null. */
function useExport(slug: string, renderId: string): [ExportState, () => void] {
  const [st, setSt] = useState<ExportState>({ s: 'idle' });
  const mine = useRef<string | null>(null);
  const read = useCallback(() => {
    activityList({ project: slug, limit: 50 }).then(
      (d) => {
        const it =
          d.items.find((i) => i.kind === 'export' && i.render?.id === renderId && i.job !== undefined && (mine.current === null || i.job === mine.current)) ??
          d.items.find((i) => i.kind === 'export' && i.render?.id === renderId && i.job !== undefined);
        if (it?.job) setSt({ s: 'job', job: it.job, state: it.state, ...(it.progress?.fraction !== undefined ? { fraction: it.progress.fraction } : {}), at: it.at });
      },
      () => undefined,
    );
  }, [slug, renderId]);
  useEffect(() => read(), [read]);
  // A jobs event of another project reads nothing.
  useEvents((e) => {
    if (exportReadsOn(e, slug)) read();
  });
  const start = useCallback(() => {
    setSt({ s: 'sending' });
    reviewExport({ project: slug, render_id: renderId }).then(
      (a) => {
        mine.current = a.job;
        setSt({ s: 'job', job: a.job, state: a.state });
        read();
      },
      (e: unknown) => {
        if (e instanceof SessionEnded) return;
        setSt({ s: 'refused', message: errorText(e) });
        if (e instanceof CallError && e.error.code === 'conflict') read();
      },
    );
  }, [slug, renderId, read]);
  return [st, start];
}

/** Export: the MP4 as a queued job (one at a time per render), the raw capture as a command to copy. */
export function ExportPart({ slug, x }: { slug: string; x: ScenarioRenderView }) {
  const [st, start] = useExport(slug, x.render_id);
  const running = st.s === 'sending' || (st.s === 'job' && (st.state === 'queued' || st.state === 'running'));
  const raw = rawExportCommand(slug, x.run_id);
  return (
    <div className="rv-export" data-testid="review-export-part">
      <p className="rv-actions">
        <Button variant="primary" size="sm" icon="export" data-testid="review-export" disabled={running} onClick={start}>
          {st.s === 'sending' ? 'Queueing the export…' : 'Export video (MP4)'}
        </Button>
      </p>
      <p className="rv-quiet" role="status" data-testid="review-export-state">
        {st.s === 'job' && st.state === 'queued' && <Txt text={`Export of ${versionWords(x.render_id)} queued (job ${st.job}): MP4 1080p, into the project's exports folder.`} />}
        {st.s === 'job' && st.state === 'running' && (
          <Txt text={`Exporting ${versionWords(x.render_id)}${st.fraction !== undefined ? ` · ${Math.round(st.fraction * 100)} %` : ''} (job ${st.job}).`} />
        )}
        {st.s === 'job' && st.state === 'succeeded' && (
          <>
            <Txt text={`Exported ${versionWords(x.render_id)} as MP4 `} />
            <When iso={st.at} />
            <Txt text={`: in the project's exports folder, under ${x.render_id}.`} />
          </>
        )}
        {st.s === 'job' && (st.state === 'failed' || st.state === 'cancelled' || st.state === 'interrupted') && (
          <Txt text={`The export ${st.state === 'failed' ? failedWords('failed') : failedWords(st.state as 'cancelled' | 'interrupted')} (job ${st.job}): the Activity has its message.`} />
        )}
      </p>
      {st.s === 'refused' && (
        <Callout state="fail" role="alert" title="The export was not queued">
          <p className="rv-pre" data-testid="review-export-refused">
            <Txt text={st.message} />
          </p>
        </Callout>
      )}
      {raw !== null ? (
        <Blocker fix={{ copy: raw }} testId="review-export-raw">
          The raw capture for an editing tool (an OTIO package: the capture, the cursor track and the timeline) — in a terminal:
        </Blocker>
      ) : (
        <p className="rv-quiet" data-testid="review-export-raw-off">
          The raw capture of this render cannot be named in a command here: export it with retake export-capture in a terminal.
        </p>
      )}
    </div>
  );
}
