/**
 * What the theme editor shows under its live frame: the bar (Play, Restart, what is shown), the frame's notes and the
 * workspace components the preview holds until they are allowed. Presentational: the frame's state comes in.
 */
import type { ThemePreviewAnswer } from '../../server/theme-ops.js';
import { Txt } from '../bits.js';
import { Button, Callout } from '../ui-kit/index.js';

/** A workspace component the preview does not run until it is allowed. */
export type HeldComponent = NonNullable<ThemePreviewAnswer['preview_held']>[number];

/** The bar under the frame: Play (a toggle with one name), Restart once stopped, and what the frame shows. */
export function FrameBar({
  framed,
  state,
  playing,
  drafting,
  component,
  onPlay,
  onRestart,
}: {
  framed: boolean;
  state: 'loading' | 'settled' | 'stopped';
  playing: boolean;
  drafting: boolean;
  component: string | undefined;
  onPlay(): void;
  onRestart(): void;
}) {
  return (
    <div className="tm-frame-bar">
      <Button size="sm" icon="play" aria-pressed={playing} disabled={!framed || state === 'loading'} data-testid="theme-play" onClick={onPlay}>
        Play
      </Button>
      {state === 'stopped' && (
        <Button size="sm" onClick={onRestart}>
          Restart the preview
        </Button>
      )}
      <span className="tm-quiet">{drafting ? 'Showing the colour you are changing (not written yet).' : component ? <Txt className="k-mono" text={component} /> : null}</span>
    </div>
  );
}

/** The frame's last notes (its warnings, errors, why it stopped). */
export function FrameNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="tm-notes">
      {notes.map((n, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the preview's notes, replaced whole on each read, text only: the index is the identity
        <li key={i}>
          <Txt text={n} />
        </li>
      ))}
    </ul>
  );
}

/** The workspace components the preview holds, each with its Allow button, and why an allow failed. */
export function HeldComponents({
  held,
  heldId,
  allowing,
  allowError,
  onAllow,
}: {
  held: HeldComponent[];
  heldId: string;
  allowing: string | null;
  allowError: string | null;
  onAllow(c: HeldComponent): void;
}) {
  if (held.length === 0) return null;
  return (
    <Callout state="warn" role="note" title={held.length === 1 ? 'A workspace component is not run in the preview' : `${held.length} workspace components are not run in the preview`}>
      <div data-testid="preview-held">
        <p className="tm-line" id={heldId}>
          Components of this workspace are code: the preview runs one only once you allow it, for this Studio session. Its stand-in draws until then; a render uses it either way.
        </p>
        <ul className="tm-held" aria-describedby={heldId}>
          {held.map((c) => (
            <li key={c.id} data-testid="held-component" data-id={c.id}>
              <Txt className="k-mono" text={c.id} />
              <Txt className="tm-quiet" text={` (${c.kind}, folder ${c.hash}) `} />
              <Button size="sm" data-testid="allow-component" disabled={allowing !== null} onClick={() => onAllow(c)}>
                {allowing === c.id ? 'Allowing…' : 'Allow in the preview'}
              </Button>
            </li>
          ))}
        </ul>
        {allowError && (
          <p className="tm-pre" role="alert" data-testid="allow-error">
            <Txt text={allowError} />
          </p>
        )}
      </div>
    </Callout>
  );
}
