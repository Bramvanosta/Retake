/**
 * L5.12a: Edit's stage (R4-Edit; R-UI-45) — the preview region and the transport, under it the take's facts. The
 * preview's frame itself is the screen's child (TimelineScreen.tsx owns the one PreviewFrame and its checked URL: the
 * source lint pins them there); this file draws what is around it:
 *
 * - the region (`role="region"`, "Preview, frame N of M", `aria-busy` while loading or buffering, `data-frame`,
 *   `data-loading`), the video's aspect ratio, as large as the stage allows; over it "Loading the preview…", Buffering,
 *   a browser that cannot play the codec (the tracks still work), the preview's error, a stopped preview with Restart;
 * - the transport (a kit Toolbar: one tab stop, the arrows rove — after a Tab; a control focused by a click leaves them
 *   to the playhead: review B-L5): Previous frame, Play / Pause, Next frame, the timecode
 *   with the frame, Unmute / Mute (the preview starts muted: kept although R4 draws none), Speed (0.5×, 1×, 2×), Comment
 *   (C: the newest render of the version shown, at the playhead — off with why without one), the zoom (Fit, Zoom in);
 * - the take's facts (capture, theme, length, frames, size, codec and keyframes).
 * Targets are at least 24 px (the kit's small controls are 26).
 */
import type { ReactNode } from 'react';
import type { TimelineView } from '@retake/engine';
import { Txt, plural, shown } from '../bits.js';
import { codecWords, timecode } from '../words/timeline-words.js';
import { Button, IconButton, LinkButton, Select, Toolbar } from '../ui-kit/index.js';

type Model = TimelineView['model'];
type Capture = TimelineView['capture'];

export interface EditPreviewProps {
  slug: string;
  name: string;
  m: Model;
  run: string;
  theme: string;
  capture: Capture;
  frame: number;
  /** What the playhead is on, in words (the caption under the picture). */
  words: string;
  previewOn: boolean;
  loading: boolean;
  buffering: boolean;
  playing: boolean;
  /** The browser plays the codec (null: not asked yet). */
  playable: boolean | null;
  cannotPlay: string;
  previewError?: string;
  stopped: string | null;
  onRestart: () => void;
  muted: boolean;
  onMute: () => void;
  rate: 0.5 | 1 | 2;
  onRate: (r: 0.5 | 1 | 2) => void;
  onToggle: () => void;
  onStep: (by: number) => void;
  /** The render a comment at the playhead goes on (the newest of the version shown), or null. */
  commentOn: string | null;
  zoom: 'fit' | 'zoom';
  onZoom: (z: 'fit' | 'zoom') => void;
  /** The preview frame (the screen's PreviewFrame), or nothing. */
  children: ReactNode;
}

export function EditPreview(p: EditPreviewProps) {
  const { m, frame, capture } = p;
  const duration = timecode(m.frames, m.fps);
  // As large as the stage allows, the video's ratio kept (the stage is a size container).
  const box = { width: `min(100cqw, calc(100cqh * ${m.width} / ${m.height}))`, aspectRatio: `${m.width} / ${m.height}` };
  return (
    <section className="ed-stage-wrap" aria-label="Preview and transport">
      <div className="ed-stage">
        <div
          className="ed-preview"
          role="region"
          aria-label={`Preview, frame ${(frame + 1).toLocaleString('en')} of ${m.frames.toLocaleString('en')}`}
          aria-busy={p.loading || p.buffering}
          data-testid="preview"
          data-frame={frame}
          data-loading={p.loading ? 'yes' : 'no'}
          style={box}
        >
          {shown(p.children)}
          {p.loading && (
            <p className="ed-preview-note" role="status" data-testid="preview-loading">
              Loading the preview…
            </p>
          )}
          {!p.loading && p.buffering && p.playing && (
            <p className="ed-preview-note" role="status">
              Buffering…
            </p>
          )}
          {p.playable === false && (
            <p className="ed-preview-note ed-note-message" role="status" data-testid="cannot-play">
              <Txt text={p.cannotPlay} />
            </p>
          )}
          {p.previewError !== undefined && (
            <p className="ed-preview-note ed-note-message" role="status" data-testid="preview-error">
              {'The preview cannot show this take: '}
              <Txt text={p.previewError} />
            </p>
          )}
          {p.stopped !== null && (
            <div className="ed-preview-note ed-note-message" role="alert" data-testid="preview-stopped">
              <p>
                <Txt text={p.stopped} />.
              </p>
              <Button size="sm" onClick={p.onRestart}>
                Restart the preview
              </Button>
            </div>
          )}
        </div>
      </div>
      <p className="ed-caption">
        <Txt text={p.words} />
      </p>
      <Toolbar label="Transport" clickLeavesKeys>
        <IconButton icon="chevron-left" label="Previous frame" size="sm" data-testid="prev-frame" onClick={() => p.onStep(-1)} />
        <Button size="sm" variant="primary" icon={p.playing ? 'pause' : 'play'} data-testid="play" disabled={!p.previewOn} aria-pressed={p.playing} onClick={p.onToggle}>
          {p.playing ? 'Pause' : 'Play'}
        </Button>
        <IconButton icon="chevron-right" label="Next frame" size="sm" data-testid="next-frame" onClick={() => p.onStep(1)} />
        <output className="ed-time k-mono" data-testid="timecode" aria-live="off">
          <Txt text={`${timecode(frame, m.fps)} / ${duration} · frame ${frame.toLocaleString('en')}`} />
        </output>
        <Button size="sm" variant="ghost" data-testid="mute" disabled={!p.previewOn} onClick={p.onMute}>
          {p.muted ? 'Unmute' : 'Mute'}
        </Button>
        <Select
          layout="inline"
          label="Speed"
          testId="rate"
          value={String(p.rate)}
          disabled={!p.previewOn}
          options={[
            { value: '0.5', label: '0.5×' },
            { value: '1', label: '1×' },
            { value: '2', label: '2×' },
          ]}
          onChange={(v) => p.onRate(Number(v) as 0.5 | 1 | 2)}
        />
        {p.commentOn !== null ? (
          <LinkButton
            size="sm"
            testId="comment-here"
            dataRender={p.commentOn}
            to={{ name: 'comments', slug: p.slug, scenario: p.name, at: { render: p.commentOn, frame } }}
            label={`Comment frame ${frame.toLocaleString('en')} of render ${p.commentOn}`}
          >
            Comment
          </LinkButton>
        ) : (
          <>
            <Button size="sm" disabled data-testid="comment-here-off" aria-describedby="ed-comment-why">
              Comment
            </Button>
            <span id="ed-comment-why" className="k-sr">
              No render of this version yet: render it, or comment on an earlier render from Comments
            </span>
          </>
        )}
        <IconButton icon="zoom-fit" label="Fit the whole video" size="sm" pressed={p.zoom === 'fit'} data-testid="zoom-fit" onClick={() => p.onZoom('fit')} />
        <IconButton icon="zoom-in" label="Zoom in" size="sm" pressed={p.zoom === 'zoom'} data-testid="zoom-in" onClick={() => p.onZoom('zoom')} />
      </Toolbar>
      <p className="ed-facts" data-testid="timeline-facts">
        {'Capture '}
        <Txt className="k-mono" text={p.run} />
        {' · theme '}
        <Txt text={p.theme} />
        <Txt text={` · ${duration} · ${plural(m.frames, 'frame')} at ${m.fps} fps · ${m.width}×${m.height}`} />
        {capture.codec && (
          <span data-testid="capture-codec">
            <Txt
              text={` · ${codecWords(capture.codec)}${capture.keyframe_interval_s !== undefined ? `, keyframes ${capture.at_least ? 'at least ' : ''}every ${capture.keyframe_interval_s.toFixed(1)} s` : ''}`}
            />
            {capture.b_frames ? ', B-frames' : ''}
          </span>
        )}
      </p>
    </section>
  );
}
