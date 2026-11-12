/**
 * L5.12a: Edit's notes (R-UI-45) — what the take says beside the preview, on the kit:
 * - `EditNotices` (above the stage, each a Callout): why the switches are off (the filmed part changed since the take —
 *   with "Capture again from Shoot" —, no scenario file, a take as captured), the workspace components the preview does
 *   not run until the person allows them (Allow in the preview, by id and folder hash, for this Studio session; review A
 *   H1 c), a slow scrub on this take;
 * - `EditNotes` (under the tracks): the comments made on another take (each opens its thread), then in a closed
 *   Disclosure "Warnings and notes" what the preview could not draw (stand-ins), the notes the preview posted (≤ 20; text a
 *   component may have written) and the edit's own warnings and notes.
 * Every string from the server or the frame is a text node.
 */
import type { TimelineViewAnswer } from '../../server/ops.js';
import { Txt, plural } from '../bits.js';
import { hrefTo } from '../route.js';
import { Button, Callout, Disclosure, LinkButton, StatusMark, Tag } from '../ui-kit/index.js';

type Ready = Extract<TimelineViewAnswer, { run_id: string; model: unknown }>;
export type FrameNote = { type: 'warning' | 'error'; message: string };

/** The title of the "no switches" note: what keeps the switches off, in words that fit the case. */
function notEditableTitle(v: Ready): string {
  if (v.source.scenario_changed) return 'The filmed part changed since this take';
  if (v.hash === undefined) return 'There is no scenario file to switch';
  if (v.source.edit === 'run') return 'Switches are off for this take';
  return 'Switches are off for this file';
}

export function EditNotices({
  v,
  slug,
  name,
  proposal,
  allowing,
  allowError,
  onAllow,
}: {
  v: Ready;
  slug: string;
  name: string;
  proposal: boolean;
  allowing: string | null;
  allowError: string | null;
  onAllow: (c: { id: string; hash: string }) => void;
}) {
  const held = v.preview_held ?? [];
  return (
    <>
      {v.editable !== true && !proposal && (
        <Callout state={v.source.scenario_changed ? 'warn' : 'idle'} role="note" title={notEditableTitle(v)}>
          <p className="ed-pre" data-testid="timeline-not-editable">
            <Txt text={v.editable.why} />
          </p>
          {v.source.scenario_changed && (
            <p>
              <LinkButton size="sm" variant="ghost" to={{ name: 'run', slug, scenario: name }}>
                Capture again from Shoot
              </LinkButton>
            </p>
          )}
        </Callout>
      )}
      {held.length > 0 && (
        <Callout
          state="warn"
          role="note"
          title={held.length === 1 ? 'A workspace component is not run in the preview' : `${held.length} workspace components are not run in the preview`}
          testId="preview-held"
        >
          <p className="ed-quiet">
            Components of this workspace are code: the preview runs one only once you allow it, for this Studio session (until it stops, or the component changes). Its stand-in draws until then; a
            render uses it either way.
          </p>
          <ul className="ed-held">
            {held.map((c) => (
              <li key={c.id} data-testid="held-component" data-id={c.id}>
                <Txt className="k-mono" text={c.id} />
                <Txt className="ed-quiet" text={` (${c.kind}, folder ${c.hash}) `} />
                <Button size="sm" data-testid="allow-component" disabled={allowing !== null} onClick={() => onAllow(c)}>
                  {allowing === c.id ? 'Allowing…' : 'Allow in the preview'}
                </Button>
              </li>
            ))}
          </ul>
          {allowError && (
            <p className="ed-pre" role="alert" data-testid="allow-error">
              <Txt text={allowError} />
            </p>
          )}
        </Callout>
      )}
      {v.capture.slow_scrub && (
        <Callout state="idle" role="note" title="Note: slow scrubbing">
          <p data-testid="slow-scrub">
            <Txt text={v.capture.slow_scrub} />
          </p>
        </Callout>
      )}
    </>
  );
}

export function EditNotes({ v, slug, name, missing, notes }: { v: Ready; slug: string; name: string; missing: string[]; notes: FrameNote[] }) {
  const plan = [...v.untrusted.warnings.map((w) => ({ type: 'warning' as const, message: w })), ...v.untrusted.notes.map((n) => ({ type: 'note' as const, message: n }))];
  const elsewhere = v.pins.elsewhere;
  const count = (missing.length ? 1 : 0) + notes.length + plan.length;
  if (count === 0 && elsewhere.length === 0) return null;
  return (
    <div className="ed-notes" data-testid="timeline-notes">
      {/* The comments made on another take: links to their threads, in sight (each one opens it). */}
      {elsewhere.length > 0 && (
        <section className="ed-note-group" aria-labelledby="ed-elsewhere-h" data-testid="pins-elsewhere">
          <h2 id="ed-elsewhere-h" className="ed-h3">
            <Txt text={`Comments made on another take (${elsewhere.length})`} />
          </h2>
          <ul className="ed-elsewhere">
            {elsewhere.map((id) => (
              <li key={id}>
                <a href={hrefTo({ name: 'comments', slug, scenario: name, thread: id })} data-testid="pin-elsewhere">
                  <Txt text={v.untrusted.threads[id]?.text ?? id} />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {count > 0 && (
        <Disclosure summary={`Warnings and notes (${count})`}>
          {missing.length > 0 && (
            <p data-testid="preview-missing">
              {'Not in the preview (their stand-ins draw): '}
              <Txt text={missing.join(', ')} />
            </p>
          )}
          {notes.length > 0 && (
            <section className="ed-note-group" aria-label="From the preview">
              <p className="ed-quiet">From the preview — text a component may have written:</p>
              <ul className="ed-note-list" data-testid="preview-notes">
                {notes.map((n, i) => (
                  <li key={i}>
                    <StatusMark state={n.type === 'error' ? 'fail' : 'warn'} word={n.type === 'error' ? 'Error' : 'Warning'} /> <Txt text={n.message} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {plan.length > 0 && (
            <section className="ed-note-group" aria-label="The edit's warnings and notes">
              <p className="ed-quiet">
                <Txt text={`The edit's warnings and notes (${plural(plan.length, 'line')}):`} />
              </p>
              <ul className="ed-note-list" data-testid="plan-notes">
                {plan.map((n, i) => (
                  <li key={i}>
                    <Tag>
                      <Txt text={n.type} />
                    </Tag>{' '}
                    <Txt text={n.message} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </Disclosure>
      )}
    </div>
  );
}
