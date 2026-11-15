/**
 * The report's checks: one listbox of the check families that found something (the arrows, Home and End move the
 * selection), and the frame a selected finding points at (render_frame: one request in flight, the newest wins).
 */
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ScenarioRenderView } from '@retake/engine';
import { renderFrame } from '../data/renders.js';
import type { FrameAnswer } from '../data/ops.js';
import { Txt } from '../bits.js';
import { FrameRequests, newSessionId } from '../words/comment-words.js';
import type { FrameAsk } from '../words/comment-words.js';
import { versionWords } from '../words/render-words.js';
import { NOTHING_ELSE, severityMark, shortTime, whereWords } from './review-words.js';
import type { groupFindings } from './review-words.js';
import { Jpeg } from '../Thumb.js';
import { SHEET_DATA_MAX } from '../thumbs.js';
import { RowCard, RowList, RowListItem, StatusMark } from '../ui-kit/index.js';

/** This tab's render_frame session (its newest request of a render wins on the server). */
const SESSION = newSessionId();

const optionId = (i: number) => `rv-finding-${i}`;

/** The families that found something, one listbox (each family a group); the selection follows the arrows. */
export function Checks({
  groups,
  messages,
  fps,
  labelledBy,
  selected,
  onSelect,
}: {
  groups: ReturnType<typeof groupFindings>;
  messages: string[];
  fps: number;
  labelledBy: string;
  selected: number | null;
  onSelect: (i: number) => void;
}) {
  const order = groups.flatMap((g) => g.items.map((i) => i.index));
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || order.length === 0) return;
    const at = selected !== null ? order.indexOf(selected) : -1;
    const to =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? Math.min(order.length - 1, at + 1)
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? Math.max(0, at - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? order.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    onSelect(order[to]);
    listRef.current?.querySelector(`#${optionId(order[to])}`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  };
  return (
    <div ref={listRef}>
      <RowList
        labelledBy={labelledBy}
        className="rv-checks"
        testId="review-findings"
        listbox={{ ...(selected !== null ? { activeId: optionId(selected) } : {}), tabbable: true, onKeyDown, onFocus: () => selected === null && order.length > 0 && onSelect(order[0]) }}
      >
        {groups.map((g) => (
          <RowListItem key={g.family.id} className="rv-family" testId="review-family" data={{ key: g.family.id }}>
            {/* biome-ignore lint/a11y/useSemanticElements: a family row named by its heading inside a list item; <fieldset> would bring its own border, padding and min-width */}
            <div role="group" aria-labelledby={`rv-fam-${g.family.id}`} className="rv-family-group">
              <span id={`rv-fam-${g.family.id}`} className="rv-family-name">
                <Txt text={`${g.family.label} · ${g.items.length}`} />
              </span>
              {g.items.map(({ index, finding }) => {
                const sev = severityMark(finding.severity);
                const t = finding.at?.time ?? (finding.at?.frame !== undefined ? finding.at.frame / fps : undefined);
                return (
                  <RowCard
                    key={index}
                    compact
                    option={{ id: optionId(index), active: selected === index }}
                    testId="review-finding"
                    tile={<StatusMark state={sev.state} word={sev.word} />}
                    title={messages[index] ? <Txt text={messages[index]} /> : <Txt className="k-mono" text={finding.code} />}
                    meta={[whereWords(finding.at), t !== undefined ? shortTime(t) : ''].filter(Boolean).join(' · ')}
                    selected={selected === index}
                    onSelect={() => onSelect(index)}
                  />
                );
              })}
            </div>
          </RowListItem>
        ))}
      </RowList>
    </div>
  );
}

/** The frame a finding points at (render_frame: one request in flight, the newest wins). */
export function FindingFrame({ slug, x, frame }: { slug: string; x: ScenarioRenderView; frame: number }) {
  const [image, setImage] = useState<FrameAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef<FrameRequests<FrameAnswer> | null>(null);
  useEffect(() => {
    const r = new FrameRequests<FrameAnswer>({
      fetch: (ask: FrameAsk, signal) => renderFrame({ project: slug, render_id: ask.render_id, created_at: ask.created_at, frame: ask.frame, session: SESSION }, { signal }),
      onResult: (res) => {
        if (res.ok) {
          setImage(res.data);
          setError(null);
        } else if (res.error.code !== 'cancelled') setError(res.error.message);
      },
    });
    requests.current = r;
    return () => {
      r.close();
      requests.current = null;
    };
  }, [slug]);
  useEffect(() => {
    requests.current?.want({ render_id: x.render_id, created_at: x.created_at, frame });
  }, [x.render_id, x.created_at, frame]);
  return (
    <div className="rv-frame" data-testid="review-frame" data-frame={image?.frame ?? ''} data-state={error ? 'error' : image && image.frame === frame ? 'ok' : 'waiting'}>
      {image ? (
        <Jpeg
          base64={image.base64}
          max={SHEET_DATA_MAX}
          width={image.width}
          height={image.height}
          alt={`Frame ${image.frame.toLocaleString('en')} of ${versionWords(x.render_id)}, at ${image.timecode}`}
        />
      ) : (
        <p className="rv-quiet">{error ? <Txt text={error} /> : 'Loading the frame…'}</p>
      )}
    </div>
  );
}

/** The Checks section: the families' listbox and "Nothing else found." under it, or that the review found nothing. */
export function ChecksSection({
  groups,
  messages,
  fps,
  labelledBy,
  selected,
  onSelect,
}: {
  groups: ReturnType<typeof groupFindings>;
  messages: string[];
  fps: number;
  labelledBy: string;
  selected: number | null;
  onSelect: (i: number) => void;
}) {
  return (
    <section className="rv-section" aria-labelledby={labelledBy}>
      <h2 id={labelledBy} className="rv-h2">
        Checks
      </h2>
      {groups.length > 0 ? (
        <Checks groups={groups} messages={messages} fps={fps} labelledBy={labelledBy} selected={selected} onSelect={onSelect} />
      ) : (
        <p className="rv-quiet" data-testid="review-nothing">
          The review found nothing to change.
        </p>
      )}
      {groups.length > 0 && (
        <p className="rv-quiet" data-testid="review-nothing-else">
          <Txt text={NOTHING_ELSE} />
        </p>
      )}
    </section>
  );
}
