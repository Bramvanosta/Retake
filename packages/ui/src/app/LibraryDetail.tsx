/**
 * L5.12c « Épure » 4c: one component's page in the Library (`#/p/<slug>/library/<theme>/<ns>/<name>`; was
 * LibraryScreen.tsx's Detail) — the picture large with its play controls and description, then About (kind, version,
 * source, kit compatibility, duration, formats, the themes that pick it), the slots and the params as kit DataTables
 * (column headers, row headers, a caption) and the README as text (never Markdown). Its actions are the inspector's
 * (LibraryInspector.tsx). Every manifest word is untrusted text (`Txt`).
 */
import type { LibraryComponentAnswer, LibraryItem, LibraryViewAnswer } from '../server/library-ops.js';
import type { Loaded } from './api.js';
import { APP_NAME } from './brand.js';
import { Txt } from './bits.js';
import { DefaultTag, PictureBox, PlayControls, SourceTag } from './LibraryCards.js';
import { SOURCE_WORDS, kindHeading } from './library-words.js';
import { Callout, DataTable, EmptyState, Facts } from './ui-kit/index.js';

function About({ d, item }: { d: LibraryComponentAnswer; item: LibraryItem }) {
  return (
    <Facts
      label="About"
      rows={[
        { key: 'kind', label: 'Kind', value: <Txt text={`${d.kind}${d.kinds?.length ? ` · also usable as ${d.kinds.join(', ')}` : ''}`} /> },
        { key: 'version', label: 'Version', value: <Txt className="k-mono" text={d.version} /> },
        {
          key: 'source',
          label: 'Source',
          value: (
            <>
              <SourceTag source={d.source} /> <Txt text={SOURCE_WORDS[d.source].title} />
              {d.overrides_builtin && ' It replaces the built-in of the same id in every render.'}
            </>
          ),
        },
        {
          key: 'kit',
          label: 'Kit',
          value: (
            <span data-testid="lib-kit">
              <Txt text={`Kit API ${d.kit.needs}: ${d.kit.compatible ? `works with this ${APP_NAME} (kit API ${d.kit.provided})` : `this ${APP_NAME} provides kit API ${d.kit.provided} — it does not load`}`} />
            </span>
          ),
        },
        ...(d.duration
          ? [{ key: 'duration', label: 'Duration', value: <Txt text={`${d.duration.default} s${d.duration.min !== undefined || d.duration.max !== undefined ? ` (from ${d.duration.min ?? '—'} to ${d.duration.max ?? '—'} s)` : ''}`} /> }]
          : []),
        { key: 'formats', label: 'Formats', value: <Txt text={d.variants.join(', ')} /> },
        { key: 'used', label: 'Used by', value: item.picked_by.length ? <Txt text={item.picked_by.join(', ')} /> : 'no theme of this project picks it' },
      ]}
    />
  );
}

function Slots({ d }: { d: LibraryComponentAnswer }) {
  if (!d.slots.length) return <p className="lb-quiet">No slots.</p>;
  return (
    <DataTable
      caption="Slots"
      captionHidden
      testId="lib-slots"
      columns={[
        { key: 'slot', label: 'Slot' },
        { key: 'type', label: 'Type' },
        { key: 'required', label: 'Required' },
        { key: 'from', label: 'Default from' },
        { key: 'max', label: 'Max', numeric: true },
        { key: 'what', label: 'What it is' },
      ]}
      rows={d.slots.map((s) => ({
        key: s.name,
        cells: [
          <Txt key="n" className="k-mono" text={s.name} />,
          s.type,
          s.required ? 'yes' : 'no',
          s.default_from ? <Txt key="f" className="k-mono" text={s.default_from} /> : null,
          s.max_chars ?? null,
          d.untrusted.slots[s.name] ? <Txt key="w" text={d.untrusted.slots[s.name]} /> : null,
        ],
      }))}
    />
  );
}

function Params({ d }: { d: LibraryComponentAnswer }) {
  const ps = d.untrusted.params;
  if (!ps.length) return <p className="lb-quiet">No params.</p>;
  return (
    <DataTable
      caption="Params"
      captionHidden
      testId="lib-params"
      columns={[
        { key: 'param', label: 'Param' },
        { key: 'type', label: 'Type' },
        { key: 'default', label: 'Default' },
        { key: 'values', label: 'Values' },
        { key: 'what', label: 'What it does' },
      ]}
      rows={ps.map((p, i) => ({
        key: String(i),
        cells: [
          <Txt key="n" className="k-mono" text={p.name} />,
          p.type ? <Txt key="t" text={p.type} /> : null,
          p.default !== undefined ? <Txt key="d" className="k-mono" text={p.default} /> : null,
          p.enum ? <Txt key="e" className="k-mono" text={p.enum.join(' | ')} /> : p.minimum !== undefined || p.maximum !== undefined ? <Txt key="r" text={`${p.minimum ?? '…'} to ${p.maximum ?? '…'}`} /> : null,
          p.description ? <Txt key="w" text={p.description} /> : null,
        ],
      }))}
    />
  );
}

export function LibraryDetail({ item, view, d, playing }: { item: LibraryItem; view: LibraryViewAnswer; d: Loaded<LibraryComponentAnswer>; playing: boolean }) {
  const nameId = 'lb-detail-name';
  return (
    <div className="lb-detail" data-testid="lib-detail">
      <header className="lb-detail-head">
        <h1 id={nameId} className="lb-h1">
          <Txt text={item.untrusted.name} />
        </h1>
        <p className="lb-detail-meta">
          <Txt className="k-mono" text={item.component} />
          <Txt text={` · ${kindHeading(item.kind, 1)} · in ${view.theme.name}`} />
          <SourceTag source={item.source} />
          <DefaultTag item={item} />
        </p>
      </header>
      <div className="lb-detail-top">
        <PictureBox item={item} playing={playing} large />
        <div className="lb-detail-side">
          <PlayControls item={item} playing={playing} nameId={nameId} />
          <p className="lb-line">
            <Txt text={item.untrusted.description} />
          </p>
        </div>
      </div>
      {d.state === 'loading' && <EmptyState title="Reading the component…" />}
      {d.state === 'error' && (
        <Callout state="fail" role="alert" title="This component cannot be read">
          <Txt text={d.error} />
        </Callout>
      )}
      {d.state === 'ready' && (
        <>
          <section className="lb-detail-section" aria-labelledby="lb-h-about">
            <h2 id="lb-h-about" className="lb-h2">
              About
            </h2>
            <div data-testid="lib-facts">
              <About d={d.data} item={item} />
            </div>
          </section>
          <section className="lb-detail-section" aria-labelledby="lb-h-slots">
            <h2 id="lb-h-slots" className="lb-h2">
              Slots
            </h2>
            <Slots d={d.data} />
          </section>
          <section className="lb-detail-section" aria-labelledby="lb-h-params">
            <h2 id="lb-h-params" className="lb-h2">
              Params
            </h2>
            <Params d={d.data} />
          </section>
          {d.data.untrusted.readme !== undefined && (
            <section className="lb-detail-section" aria-labelledby="lb-h-readme">
              <h2 id="lb-h-readme" className="lb-h2">
                README
              </h2>
              <pre className="lb-readme" data-testid="lib-readme">
                <Txt text={d.data.untrusted.readme} />
              </pre>
            </section>
          )}
        </>
      )}
    </div>
  );
}
