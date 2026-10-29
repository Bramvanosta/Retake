/**
 * The theme editor (L4.7 part D2, R-UI-07; `#/p/<slug>/themes/<theme>`): one theme's brand (name, URL, the outro's URL
 * and tagline, logo and wordmark picked among the theme folder's own image files — listed by name: logos show only in
 * the live frame, critique B9), colours (pickers with the palette checks after each write), the background (its type
 * and colours in one write, critique B7a), the type pair (the theme's own font files, Q4), motion bias, zoom (steps of
 * 0.01), cursor (filmed: the next capture), and a component per kind (its old params kept or dropped, B7b) — beside
 * the live frame: the theme's intro, a clip with its caption, its outro (theme_preview in the sandboxed Player; a
 * workspace component waits for the timeline's Allow card; a theme's own video / image / Lottie is said, not shown,
 * B10). "Use in this scenario" writes the scenario's `template` (critique B1).
 *
 * - The one write path is `theme_edit` on the version shown (if_match its sha256): each control's change is one
 *   verified write; the view is then read again (the new sha256, the palette checks) and the frame re-plans. A 409
 *   (someone else wrote) re-reads the theme and says the change was not written. Starters and read-only themes show
 *   their values with "Copy to edit" (theme_copy).
 * - Colours being dragged are previewed in memory (theme_preview `draft`, at most five a second: DraftThrottle) and
 *   written on release (the input's `change`).
 * - Undo / redo restore exact earlier bytes the server served (ThemeHistory, critique B14).
 * - Every string from the server (a font's name table, a warning, an error) is a text node through `Txt` or
 *   `visibleControls`; the frame runs workspace component code only on the player origin, in the sandbox.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ThemeEditResult, ThemeEditView } from '@demo-studio/engine';
import type { ThemeListAnswer, ThemePreviewAnswer } from '../server/theme-ops.js';
import { CallError, call, errorText } from './api.js';
import type { Loaded } from './api.js';
import { Badge, Loading, Notice, Txt, visibleControls } from './bits.js';
import { useUnsavedMark } from './drafts.js';
import { useEvents } from './events.js';
import { copyName, themeNameProblem } from './library-words.js';
import { PreviewFrame } from './PreviewFrame.js';
import type { PreviewConnection } from '../player/parent.js';
import type { FrameMessage } from '../player/protocol.js';
import { hrefTo } from './route.js';
import { SessionEnded } from './session.js';
import {
  COLOR_FIELDS,
  DraftThrottle,
  EDITOR_KINDS,
  NONE_WORDS,
  TARGET_WORDS,
  TEXT_MAX,
  ThemeHistory,
  USE_IN_SCENARIO_WORDS,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
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
  pickerHex,
  switchedBackground,
  textProblem,
  themeEventAction,
  useInScenarioPlan,
  usedByWords,
  written,
} from './theme-words.js';
import type { Background, ColorKey, PreviewTarget, ScenarioFacts, ThemeEdit } from './theme-words.js';
import { previewUrls } from './timeline-words.js';

/** A random lease id (22 base64url characters) for theme_preview / timeline_leave. */
function newLease(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Colours being changed and not written yet (shown in the frame only). */
interface Draft {
  colors?: Partial<Record<ColorKey, string>>;
  background?: Background;
}

interface Status {
  tone: 'info' | 'warning' | 'danger';
  text: string;
}

/** The theme as the editor reads it: theme_view, read again after each write (sequence-guarded). */
function useThemeView(theme: string): [Loaded<ThemeEditView>, () => Promise<ThemeEditView | null>] {
  const [v, setV] = useState<Loaded<ThemeEditView>>({ state: 'loading' });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const d = await call<ThemeEditView>('theme_view', { theme });
      if (n === seq.current) setV({ state: 'ready', data: d });
      return d;
    } catch (e) {
      if (n === seq.current && !(e instanceof SessionEnded)) setV({ state: 'error', error: errorText(e), ...(e instanceof CallError ? { code: e.error.code } : {}) });
      return null;
    }
  }, [theme]);
  useEffect(() => {
    setV({ state: 'loading' });
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);
  return [v, load];
}

export function ThemeEditor({ slug, theme, list }: { slug: string; theme: string; list: Loaded<ThemeListAnswer> }) {
  const [view, load] = useThemeView(theme);
  const history = useRef(new ThemeHistory());
  const [, rerender] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(null);
  // L5.2b (review B L7): a colour or background picked and not written yet is unsaved for the desktop app's quit question.
  useUnsavedMark(draft && (draft.colors || draft.background) ? { kind: 'theme_draft', project: slug } : null);
  const [target, setTarget] = useState<PreviewTarget>('intro');
  const [rippleFollows, setRippleFollows] = useState(true);
  const v = view.state === 'ready' ? view.data : null;

  // Live re-reads: this theme changed on disk (another window, Claude, a person), a component, a reconnection.
  const timer = useRef<number | null>(null);
  useEvents((e) => {
    if (!themeEventAction(e, slug, theme) || timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (busyRef.current) return;
      void load().then((d) => {
        if (d) history.current.sync(d.sha256);
        rerender((n) => n + 1);
      });
    }, 250);
  });
  useEffect(() => () => void (timer.current !== null && window.clearTimeout(timer.current)), []);

  // ── The live frame ──
  const [lease] = useState(newLease);
  useEffect(
    () => () => {
      void call('timeline_leave', { project: slug, lease }).catch(() => undefined);
    },
    [slug, lease],
  );
  const [answer, setAnswer] = useState<ThemePreviewAnswer | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const pseq = useRef(0);
  const askPreview = useCallback(
    async (d: Draft | null) => {
      const n = ++pseq.current;
      try {
        const a = await call<ThemePreviewAnswer>('theme_preview', { project: slug, theme, target, lease, ...(d && (d.colors || d.background) ? { draft: d } : {}) });
        if (n !== pseq.current) return;
        setAnswer(a);
        setPreviewError(null);
      } catch (e) {
        if (n !== pseq.current || e instanceof SessionEnded) return;
        setPreviewError(errorText(e));
      }
    },
    [slug, theme, target, lease],
  );
  const throttle = useMemo(() => new DraftThrottle<Draft>((d) => void askPreview(d)), [askPreview]);
  useEffect(() => () => throttle.cancel(), [throttle]);
  // Each version shown (and each target) previews the written theme.
  const shownSha = v?.sha256;
  useEffect(() => {
    if (shownSha === undefined) return;
    void askPreview(null);
  }, [shownSha, askPreview]);
  const setDraft = (d: Draft) => {
    setDraftState(d);
    throttle.push(d);
  };

  // ── Writes ──
  const write = async (edit: ThemeEdit, mode: 'edit' | 'undo' | 'redo' = 'edit'): Promise<boolean> => {
    if (!v || busyRef.current) return false;
    busyRef.current = true;
    setBusy(mode === 'undo' ? 'Undoing…' : mode === 'redo' ? 'Redoing…' : 'Saving…');
    throttle.cancel();
    const before = v.yaml !== null ? { text: v.yaml, sha256: v.sha256 } : null;
    const step = mode === 'undo' ? history.current.undoStep() : mode === 'redo' ? history.current.redoStep() : null;
    try {
      const r = await call<ThemeEditResult>('theme_edit', { theme, if_match: step ? step.if_match : v.sha256, edit: step ? step.edit : edit });
      const nv = await load();
      if (mode === 'undo') history.current.undone();
      else if (mode === 'redo') history.current.redone();
      else if (before && nv && nv.sha256 === r.sha256 && nv.yaml !== null) history.current.push(r.label, before, { text: nv.yaml, sha256: nv.sha256 });
      else history.current.clear();
      if (nv) history.current.sync(nv.sha256);
      const extra = [
        r.removed.some((x) => !r.label.includes(x)) ? `removed ${r.removed.join(', ')} (it contradicted the change)` : '',
        r.kept_params && Object.keys(r.kept_params).length ? `kept its params ${Object.keys(r.kept_params).join(', ')}` : '',
        r.dropped_params?.length ? `dropped its params ${r.dropped_params.join(', ')}` : '',
      ].filter(Boolean);
      const label = mode === 'undo' ? `Undone: ${step!.label}` : mode === 'redo' ? `Redone: ${step!.label}` : r.label;
      setStatus({ tone: r.warnings.length ? 'warning' : 'info', text: `${label}${extra.length ? ` — ${extra.join('; ')}` : ''}.${r.warnings.length ? ` ${r.warnings.slice(0, 3).join(' · ')}` : ''}` });
      setDraftState(null);
      return true;
    } catch (e) {
      if (e instanceof SessionEnded) return false;
      setDraftState(null);
      if (e instanceof CallError && e.error.code === 'conflict') {
        const nv = await load();
        if (nv) history.current.sync(nv.sha256);
        setStatus({ tone: 'warning', text: `The theme changed meanwhile (another window, Claude or a person): your change was not written. The editor now shows the new version — make it again if you still want it. (${e.error.message})` });
      } else {
        setStatus({ tone: 'danger', text: `Not written: ${errorText(e)}` });
        void askPreview(null);
      }
      return false;
    } finally {
      busyRef.current = false;
      setBusy(null);
      rerender((n) => n + 1);
    }
  };
  /** A control's plan: written, refused with why (said), or nothing to do (the draft dropped). */
  const send = (plan: { edit: ThemeEdit } | { why: string } | null) => {
    if (plan === null) {
      throttle.cancel();
      if (draft) {
        setDraftState(null);
        void askPreview(null);
      }
      return;
    }
    if ('why' in plan) {
      setStatus({ tone: 'warning', text: `Not written: ${plan.why}` });
      return;
    }
    void write(plan.edit);
  };

  if (view.state === 'loading') return <Loading what={`theme ${theme}`} />;
  if (view.state === 'error' || !v) {
    return (
      <Notice tone={view.state === 'error' && view.code === 'not_found' ? 'warning' : 'danger'} role="alert" title="This theme cannot be opened">
        <p className="pre-line">
          <Txt text={view.state === 'error' ? view.error : ''} />
        </p>
        <p>
          <a href={hrefTo({ name: 'themes', slug })}>Back to the themes</a>
        </p>
      </Notice>
    );
  }
  const editable = v.editable === true;
  const off = !editable || busy !== null;
  const listed = list.state === 'ready' ? list.data : null;
  const bg = backgroundOf(v);
  const paper = typeof written(v, 'colors.paper') === 'string' ? (written(v, 'colors.paper') as string) : '#ffffff';
  const undo = history.current.undoStep();
  const redo = history.current.redoStep();
  const familyOf = (file: string) => {
    const f = v.untrusted.fonts.find((x) => x.file === file);
    return f?.family ? ` — ${visibleControls(f.family)}${f.subfamily ? ` ${visibleControls(f.subfamily)}` : ''}` : '';
  };
  const fonts = fontChoices(v);
  const images = imageChoices(v);
  const body = (written(v, 'fonts.body') as string[] | undefined) ?? [];

  return (
    <div className="theme-editor" data-testid="theme-editor" data-theme={v.name} data-sha={v.sha256} data-editable={editable ? 'yes' : 'no'}>
      <header className="screen-head th-head">
        <h1>
          <Txt text={v.name} />
        </h1>
        <p className="th-badges">
          <Badge tone={editable ? 'success' : 'warning'}>{editable ? 'Editable' : 'Read-only'}</Badge>
          <Badge>{v.source === 'starter' ? 'Starter' : 'Workspace'}</Badge>
          <span className="small muted" data-testid="theme-used-by">
            {usedByWords(v.used_by, slug)}
          </span>
        </p>
      </header>
      {!editable && <CopyToEdit slug={slug} theme={v.name} why={v.editable === true ? '' : v.editable.why} taken={listed?.themes.map((t) => t.name) ?? []} />}
      {v.issues.length > 0 && (
        <Notice tone="danger" role="note" title="This theme has problems">
          <ul>
            {v.issues.slice(0, 6).map((x, i) => (
              <li key={i}>
                <Txt text={x} />
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <div className="th-bar">
        <span className="tl-undo">
          <button type="button" className="button small" data-testid="theme-undo" disabled={!editable || busy !== null || !undo} onClick={() => void write(undo!.edit, 'undo')}>
            Undo
          </button>
          <button type="button" className="button small" data-testid="theme-redo" disabled={!editable || busy !== null || !redo} onClick={() => void write(redo!.edit, 'redo')}>
            Redo
          </button>
        </span>
        <p className={`small th-status${status ? ` th-status-${status.tone}` : ''}`} role="status" aria-live="polite" data-testid="theme-status">
          {busy ? <Badge tone="info">{busy}</Badge> : status ? <Txt text={status.text} /> : editable ? 'Each change is written at once (Undo takes it back).' : ''}
        </p>
      </div>
      <div className="th-grid">
        <div className="th-fields">
          <Section title="Brand" id="th-brand">
            <TextField label="Brand name" field="brand.name" view={v} off={off} send={send} />
            <TextField label="Brand URL" field="brand.url" view={v} off={off} send={send} hint="as shown, e.g. example.com" />
            <TextField label="Outro URL" field="outro.url" view={v} off={off} send={send} />
            <TextField label="Outro tagline" field="outro.tagline" view={v} off={off} send={send} />
            <FileSelect label="Logo" field="logo" view={v} files={images} off={off} send={send} />
            <FileSelect label="Wordmark" field="wordmark" view={v} files={images} off={off} send={send} none="None (the brand name as text)" />
            <p className="small muted">Logos show in the live frame (Intro, Outro); the files are the theme folder's own — add one there to pick it.</p>
          </Section>
          <Section title="Colours" id="th-colours">
            {COLOR_FIELDS.map((c) => {
              const w = written(v, c.field);
              return (
                <ColorField
                  key={c.key}
                  label={c.label}
                  hint={c.hint}
                  testid={`color-${c.key}`}
                  version={v.sha256}
                  value={typeof w === 'string' ? w : undefined}
                  draft={draft?.colors?.[c.key]}
                  off={off}
                  removable={isRemovable(c.field)}
                  onDraft={(hex) => setDraft({ ...draft, colors: { ...draft?.colors, [c.key]: hex } })}
                  onCommit={(hex) => send(fieldEdit(v, c.field, hex, c.key === 'accent' && rippleFollows && v.fields['cursor.ripple_color'] !== undefined ? { ripple: true } : {}))}
                  onRemove={() => send(fieldEdit(v, c.field, undefined))}
                />
              );
            })}
            <label className="th-check small">
              <input type="checkbox" checked={rippleFollows} disabled={off} onChange={(e) => setRippleFollows(e.target.checked)} data-testid="ripple-follows" /> The cursor ripple follows the accent
            </label>
            <BackgroundField
              bg={bg}
              paper={paper}
              version={v.sha256}
              draft={draft?.background}
              off={off}
              onType={(type) => send(backgroundEdit(v, switchedBackground(bg.value, type, paper)))}
              onDraft={(b) => setDraft({ ...draft, background: b })}
              onCommit={(part, hex) => send(fieldEdit(v, `background.${part}`, hex))}
            />
            <Palette view={v} />
          </Section>
          <Section title="Type" id="th-type">
            <label className="field">
              <span className="label">Display (titles)</span>
              <select value={String(written(v, 'fonts.display') ?? '')} disabled={off} data-testid="font-display" onChange={(e) => send(fieldEdit(v, 'fonts.display', e.target.value))}>
                {written(v, 'fonts.display') !== undefined && !fonts.some((f) => f.file === written(v, 'fonts.display')) && <option value={String(written(v, 'fonts.display'))}>{visibleControls(String(written(v, 'fonts.display')))} (as written)</option>}
                {fonts.map((f) => (
                  <option key={f.file} value={f.file}>
                    {visibleControls(f.file)} ({f.words}){familyOf(f.file)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="th-fonts" data-testid="font-body">
              <legend className="label">Body (one file per weight or style, 1 to 4)</legend>
              {fonts.map((f) => (
                <label key={f.file} className="th-check small">
                  <input
                    type="checkbox"
                    checked={body.includes(f.file)}
                    disabled={off}
                    onChange={(e) => {
                      const next = bodyFonts(body, f.file, e.target.checked, fonts.map((x) => x.file));
                      send(Array.isArray(next) ? fieldEdit(v, 'fonts.body', next) : next);
                    }}
                  />{' '}
                  <Txt className="mono" text={f.file} /> ({f.words})
                </label>
              ))}
            </fieldset>
            <p className="small muted">The type pair uses the theme folder's own font files (a new font comes with a new theme: its licence notes are written then).</p>
          </Section>
          <Section title="Motion and cursor" id="th-motion">
            <Chips
              legend="Style"
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
            <NumberField label="Largest zoom" field="motion.max_zoom" view={v} off={off} send={send} />
            <DefaultZoom view={v} off={off} send={send} />
            <Chips
              legend="Cursor (filmed: takes effect at the next capture)"
              name="cursor.style"
              value={String(written(v, 'cursor.style') ?? 'arrow-dark')}
              options={[
                ['arrow-dark', 'Dark arrow'],
                ['arrow-light', 'Light arrow'],
              ]}
              off={off}
              onPick={(x) => send(fieldEdit(v, 'cursor.style', x))}
            />
            <TextField label="Cursor ripple colour" field="cursor.ripple_color" view={v} off={off} send={send} hint="a hex colour or rgba(r, g, b, a)" />
          </Section>
          <Section title="Components" id="th-components">
            <p className="small muted">The component each kind uses by default. Its look in this theme: the library.</p>
            {EDITOR_KINDS.map((k) => (
              <ComponentPick key={k} kind={k} view={v} choices={listed ? componentChoices(listed.components, k) : []} slug={slug} off={off} send={send} />
            ))}
          </Section>
        </div>
        <div className="th-side">
          <section className="card th-live" aria-labelledby="th-live-h">
            <div className="card-head">
              <h2 id="th-live-h" className="card-title">
                Live preview
              </h2>
              <Chips legend="" name="target" value={target} options={(['intro', 'clip', 'outro'] as const).map((t) => [t, TARGET_WORDS[t]] as const)} off={false} onPick={(t) => setTarget(t as PreviewTarget)} compact />
            </div>
            {answer ? <LiveFrame v={answer} drafting={draft !== null} onAgain={() => void askPreview(draft)} /> : previewError ? null : <p className="small muted">Loading the preview…</p>}
            {previewError && (
              <p className="small lib-failure" role="status" data-testid="theme-preview-error">
                <Txt text={previewError} />
              </p>
            )}
          </section>
          <UseInScenario slug={slug} theme={v.name} scenarios={listed?.scenarios ?? []} onChanged={() => void load()} />
        </div>
      </div>
    </div>
  );
}

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section className="card th-section" aria-labelledby={id}>
      <h2 id={id} className="card-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

type Send = (plan: { edit: ThemeEdit } | { why: string } | null) => void;

/** A one-line text value: written on Enter or when the field is left (an empty removable field removes it). */
function TextField({ label, field, view, off, send, hint }: { label: string; field: string; view: ThemeEditView; off: boolean; send: Send; hint?: string }) {
  const w = written(view, field);
  const shown = typeof w === 'string' ? w : w === undefined ? '' : String(w);
  const [text, setText] = useState(shown);
  const id = useId();
  // A new version read (a write, a refusal, another writer): the field shows what is written.
  useEffect(() => setText(shown), [shown, view.sha256]);
  const problem = text !== shown && text !== '' && field in TEXT_MAX ? textProblem(field, text) : null;
  const commit = () => {
    if (text === shown) return;
    if (text === '' && !isRemovable(field)) return setText(shown);
    send(fieldEdit(view, field, text === '' ? undefined : text));
  };
  return (
    <label className="field" htmlFor={id}>
      <span className="label">{label}</span>
      <input
        id={id}
        className="search-input"
        value={text}
        disabled={off}
        maxLength={TEXT_MAX[field] ?? 200}
        data-testid={`text-${field}`}
        aria-invalid={problem ? true : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setText(shown);
        }}
      />
      {(problem || hint) && <span className="small muted">{problem ?? hint}</span>}
    </label>
  );
}

/** A number field (the largest zoom): written on change (Enter, the arrows, leaving it). */
function NumberField({ label, field, view, off, send }: { label: string; field: string; view: ThemeEditView; off: boolean; send: Send }) {
  const w = written(view, field);
  const shown = typeof w === 'number' ? String(w) : '';
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown, view.sha256]);
  const commit = () => {
    if (text === shown || text === '') return setText(shown);
    send(fieldEdit(view, field, Number(text)));
  };
  return (
    <label className="field th-number">
      <span className="label">{label}</span>
      <input type="number" min={ZOOM_MIN} max={ZOOM_MAX} step={ZOOM_STEP} value={text} disabled={off} data-testid={`number-${field}`} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  );
}

/** The default zoom: none, or a number from 1 to 3 (removable: the theme's default). */
function DefaultZoom({ view, off, send }: { view: ThemeEditView; off: boolean; send: Send }) {
  const w = written(view, 'motion.default_zoom');
  const [text, setText] = useState(typeof w === 'number' ? String(w) : '');
  useEffect(() => setText(typeof w === 'number' ? String(w) : ''), [w, view.sha256]);
  const mode = w === undefined ? 'default' : w === 'none' ? 'none' : 'number';
  return (
    <div className="field">
      <span className="label">Default zoom</span>
      <span className="th-inline">
        <select
          value={mode}
          disabled={off}
          aria-label="Default zoom"
          data-testid="default-zoom"
          onChange={(e) => {
            const m = e.target.value;
            if (m === 'none') send(fieldEdit(view, 'motion.default_zoom', 'none'));
            else if (m === 'default') send(fieldEdit(view, 'motion.default_zoom', undefined));
            else send(fieldEdit(view, 'motion.default_zoom', 1.2));
          }}
        >
          <option value="default">The theme's default</option>
          <option value="none">None</option>
          <option value="number">A zoom</option>
        </select>
        {mode === 'number' && (
          <input
            type="number"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            value={text}
            disabled={off}
            aria-label="Default zoom factor"
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text !== '' && Number(text) !== w && send(fieldEdit(view, 'motion.default_zoom', Number(text)))}
          />
        )}
      </span>
    </div>
  );
}

/** A logo / wordmark among the theme folder's image files (listed by name, never shown here: critique B9). */
function FileSelect({ label, field, view, files, off, send, none }: { label: string; field: string; view: ThemeEditView; files: string[]; off: boolean; send: Send; none?: string }) {
  const w = written(view, field);
  const cur = typeof w === 'string' ? w : '';
  return (
    <label className="field">
      <span className="label">{label}</span>
      <select value={cur} disabled={off} data-testid={`file-${field}`} onChange={(e) => send(fieldEdit(view, field, e.target.value === '' ? undefined : e.target.value))}>
        {none !== undefined ? <option value="">{none}</option> : cur === '' && <option value="">(not set)</option>}
        {cur !== '' && !files.includes(cur) && <option value={cur}>{visibleControls(cur)} (as written; not a usable image)</option>}
        {files.map((f) => (
          <option key={f} value={f}>
            {visibleControls(f)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * A colour: the picker (each move previewed in the frame, written on release — its `change`) and the hex typed
 * (written on Enter / leaving the field). The swatch shows the draft while it is dragged.
 */
function ColorField(p: { label: string; hint: string; testid: string; version: string; value?: string; draft?: string; off: boolean; removable: boolean; onDraft(hex: string): void; onCommit(hex: string): void; onRemove(): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const shown = p.draft ?? p.value;
  const [text, setText] = useState(p.value ?? '');
  useEffect(() => setText(p.value ?? ''), [p.value, p.version]);
  const commitRef = useRef(p.onCommit);
  commitRef.current = p.onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The native change: the picker was released or closed (React's onChange is every move).
    const on = () => commitRef.current(el.value);
    el.addEventListener('change', on);
    return () => el.removeEventListener('change', on);
  }, []);
  const id = useId();
  const commitText = () => {
    if (text === (p.value ?? '')) return;
    if (text === '' && p.removable) return p.onRemove();
    if (okHex(text)) p.onCommit(text);
    else setText(p.value ?? '');
  };
  return (
    <div className="th-color" data-testid={p.testid}>
      <input ref={ref} type="color" id={id} className={pickerHex(shown) ? undefined : 'is-unset'} value={pickerHex(shown) ?? '#ffffff'} disabled={p.off} aria-describedby={`${id}-h`} onChange={(e) => p.onDraft(e.target.value)} data-testid={`${p.testid}-picker`} />
      <label htmlFor={id} className="th-color-label">
        <span className="label">{p.label}</span>
        <span id={`${id}-h`} className="small muted">
          {p.hint}
        </span>
      </label>
      <input
        className="search-input mono th-hex"
        value={text}
        placeholder={p.removable ? 'not set' : ''}
        disabled={p.off}
        maxLength={7}
        aria-label={`${p.label}, hex`}
        data-testid={`${p.testid}-hex`}
        onChange={(e) => setText(e.target.value.trim())}
        onBlur={commitText}
        onKeyDown={(e) => e.key === 'Enter' && commitText()}
      />
      {p.draft !== undefined && <span className="small th-draft">previewing {p.draft}</span>}
    </div>
  );
}

/** The background: its type (a switch writes type and colours together, critique B7a) and its colours. */
function BackgroundField({ bg, paper, version, draft, off, onType, onDraft, onCommit }: { bg: ReturnType<typeof backgroundOf>; paper: string; version: string; draft?: Background; off: boolean; onType(t: Background['type']): void; onDraft(b: Background): void; onCommit(part: 'color' | 'from' | 'to', hex: string): void }) {
  const cur = draft ?? bg.value;
  if (bg.why) {
    return (
      <p className="small muted" data-testid="background-why">
        Background: <Txt text={bg.why} />
      </p>
    );
  }
  const type = cur?.type ?? 'radial';
  const grad = cur && cur.type !== 'solid' ? cur : null;
  const part = (name: 'color' | 'from' | 'to', label: string) => {
    const value = cur ? (cur.type === 'solid' ? (name === 'color' ? cur.color : undefined) : name === 'from' ? cur.from : name === 'to' ? cur.to : undefined) : undefined;
    const writtenValue = bg.value ? (bg.value.type === 'solid' ? (name === 'color' ? bg.value.color : undefined) : name === 'from' ? bg.value.from : name === 'to' ? bg.value.to : undefined) : undefined;
    return (
      <ColorField
        key={name}
        label={label}
        hint=""
        testid={`background-${name}`}
        version={version}
        {...(writtenValue !== undefined ? { value: writtenValue } : {})}
        {...(draft && value !== writtenValue && value !== undefined ? { draft: value } : {})}
        off={off || !bg.value}
        removable={false}
        onDraft={(hex) => onDraft(name === 'color' ? { type: 'solid', color: hex } : { type: grad?.type ?? 'radial', from: name === 'from' ? hex : (grad?.from ?? paper), to: name === 'to' ? hex : (grad?.to ?? paper) })}
        onCommit={(hex) => onCommit(name, hex)}
        onRemove={() => undefined}
      />
    );
  };
  return (
    <div className="th-bg" data-testid="background">
      <label className="field">
        <span className="label">Background</span>
        <select value={type} disabled={off} data-testid="background-type" onChange={(e) => onType(e.target.value as Background['type'])}>
          <option value="solid">Solid</option>
          <option value="radial">Radial gradient</option>
          <option value="linear">Linear gradient</option>
        </select>
      </label>
      {type === 'solid' ? part('color', 'Background colour') : [part('from', 'From (centre / top)'), part('to', 'To (edge / bottom)')]}
    </div>
  );
}

/** The contrast checks of the colours as written (each with its ratio and minimum, in words). */
function Palette({ view }: { view: ThemeEditView }) {
  const rows = paletteRows(view);
  if (!rows.length) return <p className="small muted">The contrast checks show when every colour is a hex value.</p>;
  return (
    <div className="th-palette" data-testid="palette">
      <span className="label">Contrast</span>
      <ul>
        {rows.map((r) => (
          <li key={r.check} data-check={r.check} data-ok={r.ok ? 'yes' : 'no'}>
            <Badge tone={r.ok ? 'success' : 'warning'}>{r.ok ? 'passes' : 'low'}</Badge> {r.words}: {r.ratio.toFixed(2)}:1 (at least {r.min}:1)
          </li>
        ))}
      </ul>
      {view.palette?.warnings.map((w, i) => (
        <p key={i} className="small muted">
          <Txt text={w} />
        </p>
      ))}
    </div>
  );
}

/** Radio chips (a pick writes at once). */
function Chips({ legend, name, value, options, off, onPick, compact = false }: { legend: string; name: string; value: string; options: ReadonlyArray<readonly [string, string]>; off: boolean; onPick(v: string): void; compact?: boolean }) {
  const id = useId();
  return (
    <fieldset className={compact ? 'chips th-chips-compact' : 'chips'} data-testid={`chips-${name}`}>
      {legend ? <legend className="label">{legend}</legend> : <legend className="sr-only">Show</legend>}
      {options.map(([k, label]) => (
        <label key={k} className={value === k ? 'chip current' : 'chip'}>
          <input type="radio" name={`${id}-${name}`} value={k} checked={value === k} disabled={off} onChange={() => onPick(k)} />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

/** A kind's component: the pick (or none for captions / transitions) and, when params are written, keep or drop them. */
function ComponentPick({ kind, view, choices, slug, off, send }: { kind: (typeof EDITOR_KINDS)[number]; view: ThemeEditView; choices: string[]; slug: string; off: boolean; send: Send }) {
  const row = componentRow(view, kind);
  const [params, setParams] = useState<'keep' | 'drop'>('drop');
  const none = NONE_WORDS[kind];
  const all = row.picked && !choices.includes(row.picked) ? [row.picked, ...choices] : choices;
  return (
    <div className="th-comp" data-testid={`component-${kind}`}>
      <label className="field">
        <span className="label">{kindLabel(kind)}</span>
        <select value={row.picked ?? ''} disabled={off || row.why !== undefined} onChange={(e) => send(componentEdit(view, kind, e.target.value === '' ? null : e.target.value, params))}>
          {(none || row.picked === null) && <option value="">{none ?? '(not set)'}</option>}
          {all.map((id) => (
            <option key={id} value={id}>
              {componentOptionWords(id, choices)}
            </option>
          ))}
        </select>
      </label>
      {row.why && (
        <p className="small muted">
          <Txt text={row.why} />
        </p>
      )}
      {row.params.length > 0 && !row.why && (
        <fieldset className="chips th-params">
          <legend className="small muted">Its params ({row.params.slice(0, 6).join(', ')}) when you switch it</legend>
          <label className={params === 'drop' ? 'chip current' : 'chip'}>
            <input type="radio" name={`params-${kind}`} checked={params === 'drop'} disabled={off} onChange={() => setParams('drop')} />
            Drop them
          </label>
          <label className={params === 'keep' ? 'chip current' : 'chip'}>
            <input type="radio" name={`params-${kind}`} checked={params === 'keep'} disabled={off} onChange={() => setParams('keep')} />
            Keep them (checked against the new one)
          </label>
        </fieldset>
      )}
      {row.picked && (
        <a className="small" href={hrefTo({ name: 'library', slug, theme: view.name, component: row.picked })}>
          See it in the library
        </a>
      )}
    </div>
  );
}

/** "Copy to edit": a starter or read-only theme copied to a workspace theme (theme_copy), then opened. */
function CopyToEdit({ slug, theme, why, taken }: { slug: string; theme: string; why: string; taken: string[] }) {
  const [name, setName] = useState(() => copyName(theme, taken));
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});
  const problem = themeNameProblem(name, taken);
  const copy = async () => {
    if (problem) return setState({ error: problem });
    setState({ busy: true });
    try {
      const c = await call<{ name: string }>('theme_copy', { from: theme, name });
      location.hash = hrefTo({ name: 'themes', slug, theme: c.name });
    } catch (e) {
      if (!(e instanceof SessionEnded)) setState({ error: errorText(e) });
    }
  };
  return (
    <Notice tone="info" role="note" title="Read-only here">
      <p className="small" data-testid="theme-readonly-why">
        <Txt text={why} />
      </p>
      <div className="th-inline">
        <label className="field">
          <span className="label">Name of the copy</span>
          <input className="search-input mono" value={name} maxLength={100} onChange={(e) => setName(e.target.value.trim())} data-testid="theme-copy-name" />
        </label>
        <button type="button" className="button primary" disabled={state.busy || !!problem} onClick={() => void copy()} data-testid="theme-copy">
          {state.busy ? 'Copying…' : 'Copy to edit'}
        </button>
      </div>
      {(state.error || problem) && (
        <p className="small lib-failure" role="status">
          <Txt text={state.error ?? problem ?? ''} />
        </p>
      )}
    </Notice>
  );
}

/**
 * The frame of a theme_preview answer: the sandboxed Player loads the preview at its still's moment and settles
 * there; Play loops it. A workspace component it uses waits for Allow (the timeline's card, preview_allow).
 */
function LiveFrame({ v, drafting, onAgain }: { v: ThemePreviewAnswer; drafting: boolean; onAgain(): void }) {
  const urls = 'frame_url' in v ? previewUrls(v.frame_url, v.plan_url) : null;
  const frameRef = useRef(0);
  if ('frame' in v) frameRef.current = v.frame;
  const [state, setState] = useState<'loading' | 'settled' | 'stopped'>('loading');
  const [settles, setSettles] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [restart, setRestart] = useState(0);
  const [allowing, setAllowing] = useState<string | null>(null);
  const [allowError, setAllowError] = useState<string | null>(null);
  const conn = useRef<PreviewConnection | null>(null);
  const onMessage = useCallback((m: FrameMessage) => {
    switch (m.type) {
      case 'loaded':
        setNotes(m.warnings.slice(0, 4));
        return;
      case 'settled':
        setState('settled');
        setSettles((n) => n + 1);
        return;
      case 'state':
        setPlaying(m.playing);
        return;
      case 'warning':
      case 'error':
        setNotes((n) => [...n, m.message].slice(-4));
        return;
    }
  }, []);
  const onHello = useCallback(() => {
    setState('loading');
    setPlaying(false);
  }, []);
  const onStop = useCallback((reason: string) => {
    setState('stopped');
    setNotes((n) => [...n, reason].slice(-4));
  }, []);
  const onConnection = useCallback((c: PreviewConnection | null) => {
    conn.current = c;
  }, []);
  // A new plan (a write, a draft) loads into the same frame: loading until it settles.
  const planSeen = useRef(urls?.plan);
  useLayoutEffect(() => {
    if (urls?.plan === planSeen.current) return;
    planSeen.current = urls?.plan;
    if (!conn.current?.connected) return;
    setPlaying(false);
    setState('loading');
  }, [urls?.plan]);
  const held = v.preview_held ?? [];
  const allow = (c: { id: string; hash: string }) => {
    setAllowing(c.id);
    setAllowError(null);
    call('preview_allow', { id: c.id, hash: c.hash })
      .then(
        () => {
          setRestart((n) => n + 1);
          onAgain();
        },
        (e: unknown) => setAllowError(errorText(e)),
      )
      .finally(() => setAllowing(null));
  };
  return (
    <div className="th-frame-wrap">
      <div className="th-frame" role="region" aria-label="Live preview" aria-busy={state === 'loading'} data-testid="theme-preview" data-state={urls ? state : 'none'} data-settles={settles}>
        {urls && state !== 'stopped' && <PreviewFrame key={`${urls.frame}#${restart}`} url={urls.frame} planUrl={urls.plan} frameRef={frameRef} onMessage={onMessage} onHello={onHello} onStop={onStop} onConnection={onConnection} />}
        {urls && state === 'loading' && (
          <p className="tl-preview-note" role="status">
            Loading the preview…
          </p>
        )}
        {'not_previewed' in v && (
          <p className="tl-preview-note is-message" role="status" data-testid="theme-not-previewed">
            <Txt text={`Not previewed: ${v.not_previewed}.`} />
          </p>
        )}
        {'preview_error' in v && (
          <p className="tl-preview-note is-message" role="status" data-testid="theme-preview-error">
            The preview cannot show this: <Txt text={v.preview_error} />
          </p>
        )}
      </div>
      <div className="th-frame-bar">
        <button type="button" className="button small" aria-pressed={playing} disabled={!urls || state === 'loading'} data-testid="theme-play" onClick={() => conn.current?.send(playing ? { type: 'pause' } : { type: 'play' })}>
          {playing ? 'Pause' : 'Play'}
        </button>
        {state === 'stopped' && (
          <button type="button" className="button small" onClick={() => (setRestart((n) => n + 1), setState('loading'))}>
            Restart the preview
          </button>
        )}
        <span className="small muted">{drafting ? 'Showing the colour you are changing (not written yet).' : v.target.component ? <Txt className="mono" text={v.target.component} /> : null}</span>
      </div>
      {notes.length > 0 && (
        <ul className="small muted th-notes">
          {notes.map((n, i) => (
            <li key={i}>
              <Txt text={n} />
            </li>
          ))}
        </ul>
      )}
      {held.length > 0 && (
        <Notice tone="warning" role="note" title={held.length === 1 ? 'A workspace component is not run in the preview' : `${held.length} workspace components are not run in the preview`}>
          <div data-testid="preview-held">
            <p className="small">Components of this workspace are code: the preview runs one only once you allow it, for this Studio session. Its stand-in draws until then; a render uses it either way.</p>
            <ul className="held-list">
              {held.map((c) => (
                <li key={c.id} data-testid="held-component" data-id={c.id}>
                  <Txt className="mono" text={c.id} /> <span className="muted small">({c.kind}, folder {c.hash})</span>{' '}
                  <button type="button" className="button small" data-testid="allow-component" disabled={allowing !== null} onClick={() => allow(c)}>
                    {allowing === c.id ? 'Allowing…' : 'Allow in the preview'}
                  </button>
                </li>
              ))}
            </ul>
            {allowError && (
              <p className="pre-line small" role="alert" data-testid="allow-error">
                <Txt text={allowError} />
              </p>
            )}
          </div>
        </Notice>
      )}
    </div>
  );
}

type UseState =
  | { s: 'idle' }
  | { s: 'busy' }
  | { s: 'done'; scenario: string; label: string; hash: string; previous: { text: string; hash: string } }
  | { s: 'already'; scenario: string }
  | { s: 'undone'; scenario: string }
  | { s: 'error'; message: string };

/**
 * "Use in this scenario" (critique B1): the scenario's `template` set to this theme through scenario_edit `set_field`
 * on the version scenario_blocks showed; Undo restores those exact bytes. Every existing take re-plans with it at its
 * next render (L5.5); the cursor style is filmed.
 */
function UseInScenario({ slug, theme, scenarios, onChanged }: { slug: string; theme: string; scenarios: string[]; onChanged(): void }) {
  const [scenario, setScenario] = useState(scenarios[0] ?? '');
  const [st, setSt] = useState<UseState>({ s: 'idle' });
  useEffect(() => {
    if (!scenario && scenarios[0]) setScenario(scenarios[0]);
  }, [scenario, scenarios]);
  const fail = (e: unknown) => {
    if (!(e instanceof SessionEnded)) setSt({ s: 'error', message: e instanceof CallError && e.error.code === 'conflict' ? 'The scenario changed meanwhile: nothing was written. Try again.' : errorText(e) });
  };
  const use = async () => {
    setSt({ s: 'busy' });
    try {
      const b = await call<ScenarioFacts>('scenario_blocks', { project: slug, name: scenario });
      const plan = useInScenarioPlan(b, theme);
      if ('already' in plan) return setSt({ s: 'already', scenario });
      if ('why' in plan) return setSt({ s: 'error', message: plan.why });
      const r = await call<{ hash: string; label: string }>('scenario_edit', { project: slug, name: scenario, hash: b.hash, edit: plan.edit });
      setSt({ s: 'done', scenario, label: r.label, hash: r.hash, previous: { text: b.text, hash: b.hash } });
      onChanged();
    } catch (e) {
      fail(e);
    }
  };
  const undo = async (d: Extract<UseState, { s: 'done' }>) => {
    setSt({ s: 'busy' });
    try {
      await call('scenario_edit', { project: slug, name: d.scenario, hash: d.hash, edit: { kind: 'restore', text: d.previous.text, text_hash: d.previous.hash } });
      setSt({ s: 'undone', scenario: d.scenario });
      onChanged();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <section className="card th-use" aria-labelledby="th-use-h" data-testid="use-in-scenario">
      <h2 id="th-use-h" className="card-title">
        Use in a scenario
      </h2>
      {scenarios.length === 0 ? (
        <p className="small muted">This project has no scenario yet.</p>
      ) : (
        <>
          <div className="th-inline">
            <label className="field">
              <span className="label">Scenario</span>
              <select value={scenario} onChange={(e) => setScenario(e.target.value)} data-testid="use-scenario">
                {scenarios.map((s) => (
                  <option key={s} value={s}>
                    {visibleControls(s)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button" disabled={st.s === 'busy' || !scenario} onClick={() => void use()} data-testid="use-in-scenario-go">
              Use in this scenario
            </button>
          </div>
          <p className="small muted">{USE_IN_SCENARIO_WORDS} The project's own theme stays as project.yaml names it.</p>
        </>
      )}
      <div className="small" role="status" aria-live="polite" data-testid="use-in-scenario-state">
        {st.s === 'busy' && 'Writing the scenario…'}
        {st.s === 'already' && (
          <>
            <Txt text={st.scenario} /> already uses <Txt text={theme} />.
          </>
        )}
        {st.s === 'undone' && (
          <>
            Undone: <Txt text={st.scenario} /> is back to the version before.
          </>
        )}
        {st.s === 'error' && (
          <span className="lib-failure">
            <Txt text={st.message} />
          </span>
        )}
        {st.s === 'done' && (
          <>
            <Txt text={st.label} />.{' '}
            <a href={hrefTo({ name: 'timeline', slug, scenario: st.scenario })} data-testid="use-in-scenario-timeline">
              Open its timeline
            </a>{' '}
            <button type="button" className="button small" onClick={() => void undo(st)} data-testid="use-in-scenario-undo">
              Undo
            </button>
          </>
        )}
      </div>
    </section>
  );
}
