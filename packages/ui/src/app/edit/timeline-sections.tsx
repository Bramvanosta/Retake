/** The timeline screen's parts around the stage: the shell's slots, what sits above the stage, and the tracks. */
import type { TimelineView } from '@retake/engine';
import { Txt } from '../bits.js';
import { EditNotices } from './EditNotes.js';
import { EditStatus } from './EditStatus.js';
import { ProposalBanner } from '../review/ProposalBanner.js';
import { RenderOutcome } from '../review/Renders.js';
import type { RenderTarget, useRenders } from '../review/Renders.js';
import type { versionNote } from '../words/render-words.js';
import { hrefTo } from '../route.js';
import { ShellSlot } from '../shell/slots.js';
import { Callout, Playhead, Scrubber, Select } from '../ui-kit/index.js';
import { TimelineInspector } from './TimelineInspector.js';
import type { useSwitchEditor } from './TimelineInspector.js';
import { Tracks } from './TimelineTracks.js';
import { timecode } from '../words/timeline-words.js';
import type { PreviewedProposal, PreviewState, Ready } from './timeline-preview.js';

/** The shell's slots: the take picker, the inspector, the status bar. */
export function TimelineSlots({
  slug,
  name,
  v,
  proposal,
  segment,
  ed,
  stepsOf,
  renders,
  renderTarget,
  shownVersion,
  inApp,
}: {
  slug: string;
  name: string;
  v: Ready;
  proposal: PreviewedProposal | undefined;
  segment: Ready['model']['segments'][number] | null;
  ed: ReturnType<typeof useSwitchEditor>;
  stepsOf: (id: string) => number;
  renders: ReturnType<typeof useRenders>;
  renderTarget: RenderTarget;
  shownVersion: Parameters<typeof versionNote>[1];
  inApp: boolean;
}) {
  return (
    <>
      {v.runs.length > 1 && !proposal && (
        <ShellSlot name="context">
          <Select
            layout="inline"
            label="Take"
            testId="timeline-run-picker"
            value={v.run_id}
            options={v.runs.map((r) => ({ value: r, label: r }))}
            onChange={(r) => (location.hash = hrefTo({ name: 'timeline', slug, scenario: name, run: r }))}
          />
        </ShellSlot>
      )}
      <ShellSlot name="inspector" inline="Inspector">
        <TimelineInspector v={v} segment={segment} ed={ed} fps={v.model.fps} stepsOf={stepsOf} />
      </ShellSlot>
      <ShellSlot name="actions">
        <EditStatus
          slug={slug}
          name={name}
          source={{ proposal: proposal !== undefined, edit: v.source.edit, run: v.run_id, ...(v.source.edit_changes ? { changes: v.source.edit_changes } : {}) }}
          r={renders}
          target={renderTarget}
          shown={shownVersion}
          ed={ed}
          inApp={inApp}
        />
      </ShellSlot>
    </>
  );
}

/** Above the stage: the proposal's banner, the render's outcome, the seek's note and the take's notices. */
export function EditTop({
  slug,
  name,
  v,
  proposal,
  renders,
  seekNote,
  allowing,
  allowError,
  onAllow,
}: {
  slug: string;
  name: string;
  v: Ready;
  proposal: PreviewedProposal | undefined;
  renders: ReturnType<typeof useRenders>;
  seekNote: string | null;
  allowing: string | null;
  allowError: string | null;
  onAllow: (c: { id: string; hash: string }) => void;
}) {
  return (
    <div className="ed-top">
      {proposal && <ProposalBanner slug={slug} name={name} proposal={proposal} shown={v.proposal?.shown} />}
      <RenderOutcome r={renders} />
      {seekNote && (
        <Callout state="idle" role="status" title="Note: made from another version" testId="edit-seek-note">
          <Txt text={seekNote} />
        </Callout>
      )}
      <EditNotices v={v} slug={slug} name={name} proposal={proposal !== undefined} allowing={allowing} allowError={allowError} onAllow={onAllow} />
    </div>
  );
}

/** The tracks: the scrubber, the lanes and the playhead (zoomed or fit), and the keys' line. */
export function TrackSection({
  v,
  p,
  factor,
  last,
  words,
  marks,
  onSeek,
  selected,
  onSelect,
  at,
  commentOn,
}: {
  v: Ready;
  p: PreviewState;
  factor: number;
  last: number;
  words: string;
  marks: Array<{ at: number; label: string }>;
  onSeek: (to: number) => void;
  selected: string | null;
  onSelect: (id: string, from: number) => void;
  at: { slug: string; scenario: string };
  commentOn: string | null;
}) {
  const m = v.model;
  const { scroller, zoom, frame } = p;
  const width = zoom === 'fit' ? '100%' : `${factor * 100}%`;
  return (
    <section className="ed-tracks" aria-label="Tracks">
      <div className="ed-scroll" ref={scroller} data-testid="timeline-scroll" data-zoom={zoom}>
        <div className="ed-inner" style={{ width }}>
          <Scrubber testId="scrubber" time={timecode(frame, m.fps)} max={last} value={frame} valueText={words} onChange={onSeek} marks={marks} />
          <Tracks view={v as TimelineView} onSeek={onSeek} selected={selected} onSelect={onSelect} at={at} />
          <Playhead testId="playhead" at={frame / Math.max(1, m.frames)} />
        </div>
      </div>
      <p className="ed-keys">
        Space plays or pauses · ← → one frame · Shift + ← → one second · Home / End · [ ] the previous / next segment · ⌘Z undoes a switch · C comments the frame
        <Txt text={commentOn ? ` on ${commentOn}` : ' (no render of this version yet: render it, or comment an earlier render from Comments)'} />
      </p>
    </section>
  );
}

/** Time labels under the scrubber: about a dozen across what is on screen, on a round step (1 s … 5 min). */
export function timeMarks(frames: number, fps: number, factor: number): Array<{ at: number; label: string }> {
  const seconds = frames / Math.max(1, fps);
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => seconds / s <= 12 * factor) ?? 600;
  const out: Array<{ at: number; label: string }> = [];
  for (let t = 0; t <= seconds && out.length < 400; t += step) {
    const m = Math.floor(t / 60);
    out.push({ at: t / seconds, label: `${m}:${String(Math.floor(t - m * 60)).padStart(2, '0')}` });
  }
  return out;
}
