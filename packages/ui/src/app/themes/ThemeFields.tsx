/**
 * The theme editor's fields in the inspector — Brand (name, URL, the outro's URL and tagline, logo and wordmark among
 * the theme folder's own image files, listed by name), Colours (the kit's ColorField: the native picker previews each
 * move in the frame and writes on release, the hex writes on Enter; the cursor ripple following the accent; the
 * background's type and colours in one write; the contrast checks after each write), Type (the theme's own font files),
 * Motion and cursor (style, max zoom in steps of 0.01, the default zoom, the cursor: filmed, the ripple colour) and
 * Components (one per kind, its old params kept or dropped). Each section is an anchor of the browser (`data-section`).
 * A colour drag re-renders the dragged field (and the frame), not the editor — the sections
 * are memoised on the theme shown, `send` / `setDraft` are stable, each colour row is memoised on its own value / draft;
 * a colour field's `version` is the theme's sha256 (a refused write re-read shows what is written).
 * Every control sends a plan through `send` (ThemeEditor.tsx owns the one write path, theme_edit with if_match). This
 * file holds no colour: what a colour input shows when nothing is written comes from theme-words.ts / the editor (theme
 * data). Every string from the server (a font's name table, a warning) is text.
 */
import { memo, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ThemeEditView } from '@retake/engine';
import type { ThemeListAnswer } from '../../server/theme-ops.js';
import { Txt, shown, visibleControls } from '../bits.js';
import { DefaultZoom, FileSelect, ThemeText, ZoomField } from './theme-controls.js';
import type { Send } from './theme-controls.js';
import {
  BODY_FONTS_MAX,
  COLOR_FIELDS,
  EDITOR_KINDS,
  NONE_WORDS,
  backgroundEdit,
  backgroundOf,
  bodyFonts,
  componentChoices,
  componentEdit,
  componentOptionWords,
  componentRow,
  fieldEdit,
  fontChoices,
  imageChoices,
  isRemovable,
  kindLabel,
  okHex,
  paletteRows,
  pickerValue,
  switchedBackground,
  written,
} from '../words/theme-words.js';
import type { Background, ColorKey } from '../words/theme-words.js';
import { ChoiceChips, ColorField, InspectorSection, LinkButton, Segmented, Select, StatusMark, Switch } from '../ui-kit/index.js';

export type { Send } from './theme-controls.js';

/** Colours being changed and not written yet (shown in the frame only). */
export interface Draft {
  colors?: Partial<Record<ColorKey, string>>;
  background?: Background;
}

/** The browser's anchors: each section's key and title. */
export const SECTIONS = [
  { key: 'brand', title: 'Brand' },
  { key: 'colours', title: 'Colours' },
  { key: 'type', title: 'Type' },
  { key: 'motion', title: 'Motion and cursor' },
  { key: 'components', title: 'Components' },
] as const;

/** Scrolls a section into view and gives it the focus (a browser row's action). */
export function showSection(key: string): void {
  const el = document.querySelector<HTMLElement>(`[data-section="${key}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'start', behavior: 'auto' });
  el.focus({ preventScroll: true });
}

function Section({ k, title, hint, children }: { k: string; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="tm-section" data-section={k} tabIndex={-1}>
      <InspectorSection title={title}>
        {hint && <p className="tm-quiet">{shown(hint)}</p>}
        {shown(children)}
      </InspectorSection>
    </div>
  );
}

/** A choice of a few, written at once by a pick (the kit's chips: the arrows move, Space / Enter picks). */
function Chips({ label, name, value, options, off, onPick }: { label: string; name: string; value: string; options: ReadonlyArray<readonly [string, string]>; off: boolean; onPick(v: string): void }) {
  const id = useId();
  return (
    <div className="tm-chips" data-testid={`chips-${name}`}>
      <span id={id} className="tm-label">
        <Txt text={label} />
      </span>
      <ChoiceChips labelledBy={id} off={off} chips={options.map(([k, l]) => ({ key: k, value: k, label: l, checked: value === k }))} onPick={onPick} />
    </div>
  );
}

/** The background: its type (a switch writes type and colours together) and its colours. */
function BackgroundField({
  bg,
  paper,
  draft,
  off,
  version,
  onType,
  onDraft,
  onCommit,
}: {
  bg: ReturnType<typeof backgroundOf>;
  paper: string;
  draft?: Background;
  off: boolean;
  version: string;
  onType(t: Background['type']): void;
  onDraft(b: Background): void;
  onCommit(part: 'color' | 'from' | 'to', hex: string): void;
}) {
  const cur = draft ?? bg.value;
  if (bg.why) {
    return (
      <p className="tm-quiet" data-testid="background-why">
        {'Background: '}
        <Txt text={bg.why} />
      </p>
    );
  }
  const type = cur?.type ?? 'radial';
  const grad = cur && cur.type !== 'solid' ? cur : null;
  const partOf = (b: Background | null | undefined, name: 'color' | 'from' | 'to') =>
    b ? (b.type === 'solid' ? (name === 'color' ? b.color : undefined) : name === 'from' ? b.from : name === 'to' ? b.to : undefined) : undefined;
  const part = (name: 'color' | 'from' | 'to', label: string) => {
    const value = partOf(cur, name);
    const writtenValue = partOf(bg.value, name);
    const dragged = draft && value !== writtenValue && value !== undefined ? value : undefined;
    return (
      <ColorField
        key={name}
        label={label}
        value={writtenValue ?? ''}
        picker={pickerValue(dragged ?? writtenValue)}
        unset={writtenValue === undefined && dragged === undefined}
        {...(okHex(writtenValue) ? { swatch: writtenValue } : {})}
        {...(dragged !== undefined ? { draft: dragged } : {})}
        disabled={off || !bg.value}
        version={version}
        testId={`background-${name}`}
        onDraft={(hex) =>
          onDraft(
            name === 'color' ? { type: 'solid', color: hex } : { type: grad?.type ?? 'radial', from: name === 'from' ? hex : (grad?.from ?? paper), to: name === 'to' ? hex : (grad?.to ?? paper) },
          )
        }
        onCommit={(hex) => onCommit(name, hex)}
      />
    );
  };
  return (
    <div className="tm-group" data-testid="background">
      <Select
        label="Background"
        layout="row"
        value={type}
        disabled={off}
        testId="background-type"
        onChange={(t) => onType(t as Background['type'])}
        options={[
          { value: 'solid', label: 'Solid' },
          { value: 'radial', label: 'Radial gradient' },
          { value: 'linear', label: 'Linear gradient' },
        ]}
      />
      {(type === 'solid'
        ? ([['color', 'Background colour']] as const)
        : ([
            ['from', 'From (centre / top)'],
            ['to', 'To (edge / bottom)'],
          ] as const)
      ).map(([name, label]) => part(name, label))}
    </div>
  );
}

/** The contrast checks of the colours as written (each with its ratio and minimum, in words). */
const Palette = memo(function Palette({ view }: { view: ThemeEditView }) {
  const rows = paletteRows(view);
  if (!rows.length) return <p className="tm-quiet">The contrast checks show when every colour is a hex value.</p>;
  return (
    <div className="tm-palette" data-testid="palette">
      <span className="tm-label">Contrast, checked against the ground each colour sits on</span>
      <ul className="tm-palette-list">
        {rows.map((r) => (
          <li key={r.check} data-check={r.check} data-ok={r.ok ? 'yes' : 'no'}>
            <StatusMark state={r.ok ? 'ok' : 'warn'} word={r.ok ? 'OK' : 'Warning: low'} /> <Txt text={`${r.words}: ${r.ratio.toFixed(2)}:1 (at least ${r.min}:1)`} />
          </li>
        ))}
      </ul>
      {view.palette?.warnings.map((w, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the palette's warnings, replaced whole on each read, text only: the index is the identity
        <p key={i} className="tm-quiet">
          <Txt text={w} />
        </p>
      ))}
    </div>
  );
});

/** A kind's component: the pick (or none for captions / transitions) and, when params are written, keep or drop them. */
function ComponentPick({ kind, view, choices, slug, off, send }: { kind: (typeof EDITOR_KINDS)[number]; view: ThemeEditView; choices: string[]; slug: string; off: boolean; send: Send }) {
  const row = componentRow(view, kind);
  const [params, setParams] = useState<'keep' | 'drop'>('drop');
  const none = NONE_WORDS[kind];
  const all = row.picked && !choices.includes(row.picked) ? [row.picked, ...choices] : choices;
  const options = [...(none || row.picked === null ? [{ value: '', label: none ?? '(not set)' }] : []), ...all.map((id) => ({ value: id, label: componentOptionWords(id, choices) }))];
  return (
    <div className="tm-comp" data-testid={`component-${kind}`}>
      <Select
        label={kindLabel(kind)}
        layout="row"
        value={row.picked ?? ''}
        disabled={off || row.why !== undefined}
        options={options}
        onChange={(x) => send(componentEdit(view, kind, x === '' ? null : x, params))}
      />
      {row.why && (
        <p className="tm-quiet">
          <Txt text={row.why} />
        </p>
      )}
      {row.params.length > 0 && !row.why && (
        <div className="tm-params">
          <Txt className="tm-quiet" text={`Its params (${row.params.slice(0, 6).join(', ')}) when you switch it:`} />
          <Segmented<'keep' | 'drop'>
            label={`The params of the ${kindLabel(kind).toLowerCase()} when you switch it`}
            size="sm"
            value={params}
            onChange={setParams}
            options={[
              { value: 'drop', label: 'Drop them', disabled: off },
              { value: 'keep', label: 'Keep them (checked)', disabled: off },
            ]}
          />
        </div>
      )}
      {row.picked && (
        <span>
          <LinkButton size="sm" variant="ghost" to={{ name: 'library', slug, theme: view.name, component: row.picked }}>
            See it in the library
          </LinkButton>
        </span>
      )}
    </div>
  );
}

export interface FieldsProps {
  v: ThemeEditView;
  slug: string;
  off: boolean;
  draft: Draft | null;
  /** The written paper colour (the background's parts start from it), as theme data. */
  paper: string;
  rippleFollows: boolean;
  setRippleFollows(on: boolean): void;
  listed: ThemeListAnswer | null;
  send: Send;
  setDraft(d: Draft): void;
}

/** A colour row's actions (stable: they read the editor's latest view and draft). */
interface ColourActions {
  draft(key: ColorKey, hex: string): void;
  commit(field: string, key: ColorKey, hex: string): void;
  remove(field: string): void;
}

/** One colour of the theme (memoised: a drag of another colour does not render it). */
const ColourRow = memo(function ColourRow({
  c,
  value,
  dragged,
  off,
  version,
  actions,
}: {
  c: (typeof COLOR_FIELDS)[number];
  value: string;
  dragged: string | undefined;
  off: boolean;
  version: string;
  actions: ColourActions;
}) {
  return (
    <ColorField
      label={c.label}
      hint={c.hint}
      value={value}
      picker={pickerValue(dragged ?? value)}
      unset={dragged === undefined && !okHex(value)}
      {...(okHex(value) ? { swatch: value } : {})}
      {...(dragged !== undefined ? { draft: dragged } : {})}
      disabled={off}
      removable={isRemovable(c.field)}
      version={version}
      testId={`color-${c.key}`}
      onDraft={(hex) => actions.draft(c.key, hex)}
      onCommit={(hex) => actions.commit(c.field, c.key, hex)}
      onRemove={() => actions.remove(c.field)}
    />
  );
});

const BrandSection = memo(function BrandSection({ v, off, send }: { v: ThemeEditView; off: boolean; send: Send }) {
  const images = imageChoices(v);
  return (
    <Section k="brand" title="Brand" hint="Logos show in the live frame (Intro, Outro); the files are the theme folder's own — add one there to pick it.">
      <ThemeText label="Brand name" field="brand.name" view={v} off={off} send={send} />
      <ThemeText label="Brand URL" field="brand.url" view={v} off={off} send={send} hint="as shown, e.g. example.com" />
      <ThemeText label="Outro URL" field="outro.url" view={v} off={off} send={send} />
      <ThemeText label="Outro tagline" field="outro.tagline" view={v} off={off} send={send} />
      <FileSelect label="Logo" field="logo" view={v} files={images} off={off} send={send} />
      <Chips
        label="Logo kind"
        name="logo_kind"
        value={String(written(v, 'logo_kind') ?? 'auto')}
        options={[
          ['auto', 'From its shape (3:1 and wider: wordmark)'],
          ['mark', 'Mark (the name beside it)'],
          ['wordmark', 'Wordmark (drawn alone)'],
        ]}
        off={off}
        onPick={(x) => send(fieldEdit(v, 'logo_kind', x === 'auto' ? undefined : x))}
      />
      <FileSelect label="Wordmark" field="wordmark" view={v} files={images} off={off} send={send} none="None (the brand name as text)" />
    </Section>
  );
});

const TypeSection = memo(function TypeSection({ v, off, send }: { v: ThemeEditView; off: boolean; send: Send }) {
  const familyOf = (file: string) => {
    const f = v.untrusted.fonts.find((x) => x.file === file);
    return f?.family ? ` — ${visibleControls(f.family)}${f.subfamily ? ` ${visibleControls(f.subfamily)}` : ''}` : '';
  };
  const fonts = fontChoices(v);
  const body = (written(v, 'fonts.body') as string[] | undefined) ?? [];
  const display = written(v, 'fonts.display');
  return (
    <Section k="type" title="Type" hint="The type pair uses the theme folder's own font files (a new font comes with a new theme: its licence notes are written then).">
      <Select
        label="Display"
        layout="row"
        value={String(display ?? '')}
        disabled={off}
        testId="font-display"
        onChange={(x) => send(fieldEdit(v, 'fonts.display', x))}
        options={[
          ...(display !== undefined && !fonts.some((f) => f.file === display) ? [{ value: String(display), label: `${String(display)} (as written)` }] : []),
          ...fonts.map((f) => ({ value: f.file, label: `${f.file} (${f.words})${familyOf(f.file)}` })),
        ]}
      />
      {/* biome-ignore lint/a11y/useSemanticElements: the body font fields under one visual label; <fieldset> would bring its own border, padding and min-width */}
      <div className="tm-group" data-testid="font-body" role="group" aria-labelledby="tm-body-fonts">
        <span id="tm-body-fonts" className="tm-label">
          <Txt text={`Body (one file per weight or style, 1 to ${BODY_FONTS_MAX})`} />
        </span>
        {fonts.map((f) => (
          <Switch
            key={f.file}
            label={<Txt className="k-mono" text={`${f.file} (${f.words})`} />}
            checked={body.includes(f.file)}
            disabled={off}
            onChange={(on) => {
              const next = bodyFonts(
                body,
                f.file,
                on,
                fonts.map((x) => x.file),
              );
              send(Array.isArray(next) ? fieldEdit(v, 'fonts.body', next) : next);
            }}
          />
        ))}
      </div>
    </Section>
  );
});

const MotionSection = memo(function MotionSection({ v, off, send }: { v: ThemeEditView; off: boolean; send: Send }) {
  return (
    <Section k="motion" title="Motion and cursor">
      <Chips
        label="Style"
        name="style_bias"
        value={String(written(v, 'style_bias') ?? 'balanced')}
        options={[
          ['real', 'Real (calm)'],
          ['balanced', 'Balanced'],
          ['motion', 'Motion'],
        ]}
        off={off}
        onPick={(x) => send(fieldEdit(v, 'style_bias', x))}
      />
      <ZoomField label="Max zoom" field="motion.max_zoom" view={v} off={off} send={send} />
      <DefaultZoom view={v} off={off} send={send} />
      <Chips
        label="Cursor (filmed: the next capture)"
        name="cursor.style"
        value={String(written(v, 'cursor.style') ?? 'arrow-dark')}
        options={[
          ['arrow-dark', 'Dark arrow'],
          ['arrow-light', 'Light arrow'],
        ]}
        off={off}
        onPick={(x) => send(fieldEdit(v, 'cursor.style', x))}
      />
      <ThemeText label="Ripple colour" field="cursor.ripple_color" view={v} off={off} send={send} hint="a hex colour, or rgba with r, g, b and a" />
    </Section>
  );
});

const ComponentsSection = memo(function ComponentsSection({ v, off, send, slug, listed }: { v: ThemeEditView; off: boolean; send: Send; slug: string; listed: ThemeListAnswer | null }) {
  return (
    <Section k="components" title="Components" hint="The component each kind uses by default. Its look in this theme: the library.">
      {EDITOR_KINDS.map((k) => (
        <ComponentPick key={k} kind={k} view={v} choices={listed ? componentChoices(listed.components, k) : []} slug={slug} off={off} send={send} />
      ))}
    </Section>
  );
});

export function ThemeFields({ v, slug, off, draft, paper, rippleFollows, setRippleFollows, listed, send, setDraft }: FieldsProps) {
  const bg = useMemo(() => backgroundOf(v), [v]);
  // The colour rows' actions read the latest view and draft (stable: a drag renders the dragged row only).
  const live = useRef({ v, draft, rippleFollows, send, setDraft });
  live.current = { v, draft, rippleFollows, send, setDraft };
  const actions = useMemo<ColourActions>(
    () => ({
      draft: (key, hex) => {
        const d = live.current.draft;
        live.current.setDraft({ ...d, colors: { ...d?.colors, [key]: hex } });
      },
      commit: (field, key, hex) => {
        const { v: cur, rippleFollows: follows } = live.current;
        live.current.send(fieldEdit(cur, field, hex, key === 'accent' && follows && cur.fields['cursor.ripple_color'] !== undefined ? { ripple: true } : {}));
      },
      remove: (field) => live.current.send(fieldEdit(live.current.v, field, undefined)),
    }),
    [],
  );
  return (
    <div className="tm-fields" data-testid="theme-fields">
      <BrandSection v={v} off={off} send={send} />
      <Section k="colours" title="Colours" hint="Each move previews in the frame; the release writes it (the hex: Enter).">
        {COLOR_FIELDS.map((c) => {
          const w = written(v, c.field);
          return <ColourRow key={c.key} c={c} value={typeof w === 'string' ? w : ''} dragged={draft?.colors?.[c.key]} off={off} version={v.sha256} actions={actions} />;
        })}
        <Switch label="The cursor ripple follows the accent" checked={rippleFollows} disabled={off} onChange={setRippleFollows} testId="ripple-follows" />
        <BackgroundField
          bg={bg}
          paper={paper}
          {...(draft?.background ? { draft: draft.background } : {})}
          off={off}
          version={v.sha256}
          onType={(type) => send(backgroundEdit(v, switchedBackground(bg.value, type, paper)))}
          onDraft={(b) => setDraft({ ...draft, background: b })}
          onCommit={(part, hex) => send(fieldEdit(v, `background.${part}`, hex))}
        />
        <Palette view={v} />
      </Section>
      <TypeSection v={v} off={off} send={send} />
      <MotionSection v={v} off={off} send={send} />
      <ComponentsSection v={v} off={off} send={send} slug={slug} listed={listed} />
    </div>
  );
}
