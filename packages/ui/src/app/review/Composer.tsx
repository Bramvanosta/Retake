/**
 * The composer under the frame, on the kit: a region dragged on the frame or typed in four % number fields (the WCAG
 * 2.5.7 alternative — rounded, then clamped inside the frame; a field left settles to the region drawn), Clear region;
 * the anchor chips the server computes with the code that stores them (`frame_anchor`, 150 ms after the frame or region
 * settles; an answer older than the newest ask is dropped: a sequence number) as kit tags; the text (unsaved while it
 * holds words: the desktop app's quit question names it), ⌘↩ or Post — `thread_add` with the render's id and created_at
 * as shown ("Posting…": the still is made after the thread). A 409 (the render was replaced) reads the renders again;
 * the text stays. The text box is described by the characters left and how ⌘↩ posts; the characters left are announced
 * politely only as thresholds are crossed (charactersLeftAnnounced), never per key. Asked to (`focusText`: an `at`
 * address, once the frame is laid out), it brings its text box and Post into view and focuses the text.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { CallError, errorText } from '../api.js';
import { frameAnchor, threadAdd } from '../data/comments.js';
import type { AnchorAnswer } from '../data/ops.js';
import { Txt } from '../bits.js';
import { COMMENT_TEXT_MAX, anchorChips, charactersLeft, charactersLeftAnnounced, fieldsOf, regionOfFields, regionWords, renderWords, sameRegion } from '../words/comment-words.js';
import type { Region, RegionFields } from '../words/comment-words.js';
import type { Shown } from './FrameViewer.js';
import { SessionEnded } from '../session.js';
import { ChipList } from './ThreadPanel.js';
import { Button, Callout, NumberField, TextArea, pageKeys } from '../ui-kit/index.js';

const FIELDS: Array<[keyof RegionFields, string]> = [
  ['x', 'Left %'],
  ['y', 'Top %'],
  ['w', 'Width %'],
  ['h', 'Height %'],
];

type AnchorState = { state: 'loading' } | { state: 'ok'; a: AnchorAnswer } | { state: 'error'; message: string };

/** The region's four % fields, typed or following the region drawn; a typed field sets the region. */
function useRegionFields(region: Region | null, setRegion: (r: Region | null) => void) {
  const [fields, setFields] = useState<RegionFields>(() => fieldsOf(region));
  // A drag (or Clear) sets the region: the fields follow — unless they already say it (the person is typing them).
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  useEffect(() => {
    if (!sameRegion(regionOfFields(fieldsRef.current), region)) setFields(fieldsOf(region));
  }, [region]);
  const setField = (k: keyof RegionFields, v: string) => {
    const next = { ...fields, [k]: v };
    setFields(next);
    setRegion(regionOfFields(next));
  };
  return { fields, setFields, setField };
}

/** The chips: the anchor the server would store (frame_anchor), 150 ms after the frame or region settles; an older answer is dropped. */
function useAnchor(slug: string, shown: Shown, frame: number, region: Region | null): AnchorState {
  const [anchor, setAnchor] = useState<AnchorState>({ state: 'loading' });
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setAnchor((a) => (a.state === 'ok' ? a : { state: 'loading' }));
    const t = setTimeout(() => {
      frameAnchor({ project: slug, render_id: shown.render_id, created_at: shown.created_at, frame, ...(region ? { region } : {}) }).then(
        (a) => n === seq.current && setAnchor({ state: 'ok', a }),
        (e: unknown) => {
          if (n !== seq.current || e instanceof SessionEnded) return;
          setAnchor({ state: 'error', message: errorText(e) });
        },
      );
    }, 150);
    return () => clearTimeout(t);
  }, [slug, shown.render_id, shown.created_at, frame, region]);
  return anchor;
}

/** Brought into view once when asked (the text box and Post), its text focused. */
function useFocusText(focusText: boolean | undefined) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const served = useRef(false);
  useEffect(() => {
    if (!focusText || served.current) return;
    served.current = true;
    actionsRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    textRef.current?.focus({ preventScroll: true });
  }, [focusText]);
  return { textRef, actionsRef };
}

export function Composer(p: {
  slug: string;
  name: string;
  shown: Shown;
  frame: number;
  region: Region | null;
  setRegion: (r: Region | null) => void;
  focusText?: boolean;
  onPosted: (id: string, warnings: string[]) => void;
  onReplaced: () => void;
}) {
  const { slug, shown, frame, region, setRegion } = p;
  const { fields, setFields, setField } = useRegionFields(region, setRegion);

  const anchor = useAnchor(slug, shown, frame, region);
  const chips = anchor.state === 'ok' ? anchorChips(anchor.a) : [];
  const fresh = anchor.state === 'ok' && anchor.a.frame === frame;

  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const post = () => {
    if (posting || text.trim() === '') return;
    setPosting(true);
    setError(null);
    threadAdd({ project: slug, render_id: shown.render_id, created_at: shown.created_at, frame, ...(region ? { region } : {}), text })
      .then(
        (r) => {
          setText('');
          p.onPosted(r.thread.id, r.warnings);
        },
        (e: unknown) => {
          if (e instanceof SessionEnded) return;
          setError(errorText(e));
          if (e instanceof CallError && e.status === 409) p.onReplaced();
        },
      )
      .finally(() => setPosting(false));
  };
  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      post();
    }
  };
  const { textRef, actionsRef } = useFocusText(p.focusText);
  const how = useId();
  const announced = charactersLeftAnnounced(text);
  const empty = region === null && fields.x === '' && fields.y === '' && fields.w === '' && fields.h === '';
  return (
    <form
      className="cm-composer"
      aria-label={`Comment frame ${frame.toLocaleString('en')} of ${renderWords(shown.render_id)}`}
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        post();
      }}
    >
      <h2 className="cm-h2">
        <Txt text={`Comment frame ${frame.toLocaleString('en')} of ${renderWords(shown.render_id)}`} />
      </h2>
      <RegionInputs fields={fields} region={region} empty={empty} setField={setField} setFields={setFields} setRegion={setRegion} />
      <AnchorChips anchor={anchor} chips={chips} fresh={fresh} />
      <TextArea
        label="Add a comment on this frame"
        rows={4}
        value={text}
        onChange={setText}
        unsaved={text.trim() ? { kind: 'comment', project: slug, scenario: p.name } : null}
        maxLength={COMMENT_TEXT_MAX}
        placeholder="What should change at this frame?"
        testId="comment-text"
        hint={charactersLeft(text)}
        describedBy={how}
        inputRef={textRef}
        onKeyDown={onKey}
      />
      <span className="k-sr" aria-live="polite" data-testid="comment-left-said">
        <Txt text={announced} />
      </span>
      <div className="cm-actions" ref={actionsRef}>
        <Button variant="primary" submit data-testid="post-comment" disabled={posting || text.trim() === ''}>
          {posting ? 'Posting…' : 'Post the comment'}
        </Button>
        <span id={how} className="cm-quiet" role="status" data-testid="comment-how">
          <Txt
            text={
              posting ? 'Posting… the thread is written, then its still is made.' : `${pageKeys('send').join('')} posts. Written as the channel Studio, under the name this Studio was started with.`
            }
          />
        </span>
      </div>
      {error && (
        <Callout state="fail" role="alert" title="The comment was not posted">
          <p className="cm-pre" data-testid="post-error">
            <Txt text={error} />
          </p>
        </Callout>
      )}
    </form>
  );
}

/** The region in % of the frame (the drag's keyboard alternative): four fields, Clear region, and the region in words. */
function RegionInputs({
  fields,
  region,
  empty,
  setField,
  setFields,
  setRegion,
}: {
  fields: RegionFields;
  region: Region | null;
  empty: boolean;
  setField: (k: keyof RegionFields, v: string) => void;
  setFields: (f: RegionFields) => void;
  setRegion: (r: Region | null) => void;
}) {
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: the region fields are a named group with a visual label; <fieldset> would bring its own border, padding and min-width */}
      <div className="cm-region" role="group" aria-label="Region (optional) — drag on the frame, or type it in % of the frame">
        <p className="cm-label" aria-hidden="true">
          Region (optional) — drag on the frame, or type it in % of the frame
        </p>
        <div className="cm-region-row">
          {FIELDS.map(([k, label]) => (
            <NumberField
              key={k}
              label={label}
              layout="stack"
              min={0}
              max={100}
              step={0.5}
              value={fields[k]}
              testId={`region-${k}`}
              onChange={(v) => setField(k, v)}
              onBlur={() => {
                if (region) setFields(fieldsOf(region));
              }}
            />
          ))}
          <Button size="sm" data-testid="region-clear" disabled={empty} onClick={() => setRegion(null)}>
            Clear region
          </Button>
        </div>
        <p className="cm-quiet" aria-live="polite" data-testid="region-words">
          <Txt text={region ? `Region ${regionWords(region)}` : 'No region: the comment is about the whole frame.'} />
        </p>
      </div>
    </>
  );
}

/** Where the comment points: the anchor's chips (or its error, or that it is being read) and its warnings. */
function AnchorChips({ anchor, chips, fresh }: { anchor: AnchorState; chips: ReturnType<typeof anchorChips>; fresh: boolean }) {
  return (
    <div className="cm-anchor" aria-busy={!fresh}>
      <p className="cm-label">Where it points</p>
      {anchor.state === 'error' ? (
        <p className="cm-pre cm-error" role="alert" data-testid="anchor-error">
          <Txt text={anchor.message} />
        </p>
      ) : chips.length ? (
        <ChipList chips={chips} label="Where this comment points" />
      ) : (
        <p className="cm-quiet" role="status">
          Reading where the frame points…
        </p>
      )}
      {anchor.state === 'ok' && anchor.a.warnings.length > 0 && (
        <ul className="cm-warnings">
          {anchor.a.warnings.map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one anchor's warnings, replaced whole on each read, text only: the index is the identity
            <li key={i}>
              <Txt text={w} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
