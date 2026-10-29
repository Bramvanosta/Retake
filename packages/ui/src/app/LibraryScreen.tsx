/**
 * The component library (L4.7 part D1, R-UI-06 / R-UI-06b; `#/p/<slug>/library[/<theme>[/<ns>/<name>]]`): every usable
 * component of the workspace by kind, each card the component's poster in the selected theme (the project's by default;
 * the switcher picks another), a source badge in words ("Built-in" / "Workspace"), "Theme default" for the selected
 * theme's picks, and Play — the component's looping GIF in place of the poster until Pause (loops never start by
 * themselves). Filters: kind, source, words. The registry's notices (components that do not load, with why and the
 * command that checks one). One component's detail: the picture large, kinds, version, source, kit compatibility,
 * duration, variants, slots and params, the themes that pick it, "Set as theme default" (one verified theme write,
 * undo; a starter is copied first) and "Create with Claude" (a prompt to copy; the Studio calls no model). "Open the
 * theme editor" leads to the selected theme's editor (L4.7 part D2).
 *
 * Safety: every manifest word (a workspace component's name, description, slot / param words, README) is agent-writable
 * text shown only through `Txt` (direction controls visible), never in an attribute; pictures reach the one `<img>`
 * only as checked data addresses (`Picture`: imageDataUrl — PNG posters, GIF loops, magic and caps); a workspace
 * component's code never runs here (its posters and loops are pixels from the worker's guarded render browser).
 * What the screen asks for and when: library-load.ts (cards on screen only, chunks of 12, a 2 s debounce, Retry).
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { ThemeEditResult, ThemeEditView } from '@demo-studio/engine';
import type { LibraryComponentAnswer, LibraryImagesAnswer, LibraryItem, LibraryViewAnswer } from '../server/library-ops.js';
import { CallError, call, errorText, useCall } from './api.js';
import { Badge, Loading, Notice, Txt, plural } from './bits.js';
import { useUnsavedMark } from './drafts.js';
import { useEvents } from './events.js';
import { LibraryImages, RenderPump } from './library-load.js';
import type { ImageEntry, ImageWant, RenderRequest } from './library-load.js';
import {
  KIND_ORDER,
  NO_FILTER,
  SOURCE_WORDS,
  alsoServing,
  alsoServingWords,
  canPlay,
  copyName,
  createPrompt,
  filterCounts,
  filterItems,
  groupByKind,
  idProblem,
  isKind,
  kindHeading,
  kindsOf,
  libraryEventAction,
  loopWords,
  okTheme,
  pictureAlt,
  posterWords,
  setDefaultPlan,
  setDefaultWords,
  themeNameProblem,
} from './library-words.js';
import type { LibraryFilter, SetDefaultPlan } from './library-words.js';
import { hrefTo } from './route.js';
import { SessionEnded } from './session.js';
import { Picture } from './Thumb.js';
import { LOOP_DATA_MAX, POSTER_DATA_MAX } from './thumbs.js';

const CARD_W = 320;
const CARD_H = 180;
const DETAIL_W = 640;
const DETAIL_H = 360;
/** Events re-read the view at most this often. */
const REREAD_MS = 250;

interface LibraryCtx {
  slug: string;
  theme: string;
  images: LibraryImages;
  pump: RenderPump;
  playing: ReadonlySet<string>;
  setPlaying(component: string, on: boolean): void;
  /** Read the view again (after a theme write: the event follows too). */
  reload(): void;
  observe(el: Element, on: (visible: boolean) => void): () => void;
}

const Ctx = createContext<LibraryCtx | null>(null);
const useLibrary = (): LibraryCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error('outside the library');
  return c;
};

/** Re-render on every change of the pump (asked keys, its error). */
function usePump(pump: RenderPump): number {
  const [n, set] = useState(0);
  useEffect(() => pump.subscribe(() => set((x) => x + 1)), [pump]);
  return n;
}

function useImage(images: LibraryImages, want: ImageWant | null): ImageEntry | undefined {
  return useSyncExternalStore(
    (fn) => (want ? images.subscribe(want, fn) : () => undefined),
    () => (want ? images.get(want) : undefined),
  );
}

/** The image a picture box wants (a poster committed or cached, a playing cached loop), or null. */
function posterWant(i: LibraryItem): ImageWant | null {
  if (i.poster.state === 'committed') return { kind: 'poster', component: i.component };
  if (i.poster.state === 'cached') return { kind: 'poster', component: i.component, key: i.poster.key };
  return null;
}
const loopWant = (i: LibraryItem): ImageWant | null => (i.loop.state === 'cached' ? { kind: 'loop', component: i.component, key: i.loop.key } : null);

const IMAGE_WORDS: Record<string, string> = {
  missing: 'The picture is not in the cache any more',
  too_large: 'The picture is too large to show',
  not_builtin: 'No committed poster for this component',
  unreadable: 'The picture cannot be shown',
  failed: 'The picture could not be loaded',
};

/**
 * A component's picture: the loop while it plays (and is there), else the poster, else words. Its box tells the
 * pump and the image loader when it is on screen.
 */
function PictureBox({ item, large = false }: { item: LibraryItem; large?: boolean }) {
  const lib = useLibrary();
  usePump(lib.pump);
  const box = useRef<HTMLDivElement>(null);
  const playing = lib.playing.has(item.component);
  // One want object per (component, state, key): the loader's subscriptions and the observer stay put across re-renders.
  const pw = useMemo(() => posterWant(item), [item.component, item.poster.state, item.poster.key]);
  const lw = useMemo(() => (playing ? loopWant(item) : null), [playing, item.component, item.loop.state, item.loop.key]);
  const poster = useImage(lib.images, pw);
  const loop = useImage(lib.images, lw);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let visible = false;
    const stop = lib.observe(el, (v) => {
      if (v === visible) return;
      visible = v;
      lib.pump.setVisible(item.component, v);
      if (pw) lib.images.setVisible(pw, v);
      if (lw) lib.images.setVisible(lw, v);
    });
    return () => {
      stop();
      if (visible) {
        lib.pump.setVisible(item.component, false);
        if (pw) lib.images.setVisible(pw, false);
        if (lw) lib.images.setVisible(lw, false);
      }
    };
    // A new want (a theme change, a new render, Play) observes again: the observer reports the box at once.
  }, [lib, item.component, pw, lw]);
  const w = large ? DETAIL_W : CARD_W;
  const h = large ? DETAIL_H : CARD_H;
  let shown: ReactNode = null;
  let state = 'words';
  if (loop?.state === 'ok') {
    shown = <Picture format="gif" base64={loop.data} max={LOOP_DATA_MAX} width={w} height={h} alt={pictureAlt(item.component, lib.theme, 'loop')} className="lib-img" />;
    state = 'loop';
  } else if (poster?.state === 'ok') {
    shown = <Picture format="png" base64={poster.data} max={POSTER_DATA_MAX} width={w} height={h} alt={pictureAlt(item.component, lib.theme, 'poster')} className="lib-img" />;
    state = 'poster';
  }
  const pWords = posterWords(item.poster, { asked: askedWord(lib.pump.askedOf(item.poster.key)) });
  const words = shown ? null : (pWords ?? (poster?.state === 'missing' ? IMAGE_WORDS[poster.reason] : pw ? 'Loading the poster…' : null));
  return (
    <div ref={box} className={large ? 'lib-pic lib-pic-large' : 'lib-pic'} data-testid="lib-picture" data-state={state}>
      {shown}
      {words && <span className="lib-pic-words">{words}</span>}
      {playing && shown && loop?.state !== 'ok' && <span className="lib-pic-note">{loop?.state === 'missing' ? IMAGE_WORDS[loop.reason] : (loopWords(item.loop, true, { asked: askedWord(lib.pump.askedOf(item.loop.key)) }) ?? 'Loading the loop…')}</span>}
    </div>
  );
}

const askedWord = (a: ReturnType<RenderPump['askedOf']>): 'asked' | 'ended' | undefined => (a === 'ended' ? 'ended' : a === 'pending' || a === 'asked' ? 'asked' : undefined);

/**
 * Play / Pause (aria-pressed), Retry of a failed poster or loop, "Render again"; the failure's words (untrusted). Each
 * button's accessible name is its words and the component's name (`aria-labelledby` the button and the element showing
 * the name: the name, agent-writable text, is never copied into an attribute — review B L1).
 */
function PreviewControls({ item, nameId }: { item: LibraryItem; nameId: string }) {
  const lib = useLibrary();
  usePump(lib.pump);
  const id = useId();
  const named = (what: string) => ({ id: `${id}-${what}`, 'aria-labelledby': `${id}-${what} ${nameId}` });
  const playing = lib.playing.has(item.component);
  const playable = canPlay(item.loop);
  const lw = loopWords(item.loop, playing, { asked: askedWord(lib.pump.askedOf(item.loop.key)) });
  const ended = lib.pump.askedOf(item.poster.key) === 'ended' || lib.pump.askedOf(item.loop.key) === 'ended';
  return (
    <div className="lib-controls">
      <button
        type="button"
        className="button small"
        aria-pressed={playing}
        disabled={!playable && !playing}
        {...named('play')}
        data-testid="lib-play"
        onClick={() => {
          lib.setPlaying(item.component, !playing);
          if (!playing) lib.pump.wantLoops([item.component]);
        }}
      >
        {playing ? 'Pause' : 'Play'}
      </button>
      {item.poster.state === 'failed' && (
        <button type="button" className="button small" {...named('retry-poster')} data-testid="lib-retry-poster" onClick={() => void lib.pump.retry(item.component, 'poster')}>
          Retry the poster
        </button>
      )}
      {item.loop.state === 'failed' && (
        <button type="button" className="button small" {...named('retry-loop')} data-testid="lib-retry-loop" onClick={() => void lib.pump.retry(item.component, 'loop')}>
          Retry the loop
        </button>
      )}
      {ended && (
        <button type="button" className="button small quiet" {...named('again')} onClick={() => lib.pump.again(item.component)}>
          Render again
        </button>
      )}
      {lw && (
        <span className="small muted" data-testid="lib-loop-words">
          {lw}
        </span>
      )}
      {(item.poster.untrusted || item.loop.untrusted) && (
        <span className="small lib-failure" data-testid="lib-failure">
          Why: <Txt text={(item.poster.untrusted ?? item.loop.untrusted)!.reason} />
        </span>
      )}
    </div>
  );
}

function SourceBadge({ source }: { source: LibraryItem['source'] }) {
  const w = SOURCE_WORDS[source];
  return (
    <span title={w.title} data-testid="lib-source">
      <Badge tone={source === 'workspace' ? 'info' : 'neutral'}>{w.badge}</Badge>
    </span>
  );
}

function DefaultBadges({ item, theme }: { item: LibraryItem; theme: string }) {
  if (!item.theme_default.length) return null;
  return (
    <span title={`${theme} uses it by default`} data-testid="lib-default">
      <Badge tone="success">Theme default{item.theme_default.length === 1 && item.theme_default[0] !== item.kind ? ` (${item.theme_default[0]})` : ''}</Badge>
    </span>
  );
}

function Card({ item }: { item: LibraryItem }) {
  const lib = useLibrary();
  const nameId = useId();
  const ns = item.component.split('/');
  return (
    <li className="lib-card" data-testid="lib-card" data-component={item.component} data-poster-state={item.poster.state} data-loop-state={item.loop.state}>
      <PictureBox item={item} />
      <div className="lib-card-body">
        <p className="lib-name" id={nameId}>
          <Txt text={item.untrusted.name} />
        </p>
        <p className="lib-id">
          <a href={hrefTo({ name: 'library', slug: lib.slug, theme: lib.theme, component: `${ns[0]}/${ns[1]}` })} data-testid="lib-open">
            <Txt className="mono" text={item.component} />
          </a>
        </p>
        <p className="lib-badges">
          <SourceBadge source={item.source} />
          <DefaultBadges item={item} theme={lib.theme} />
          {(item.poster.queued || item.loop.queued) && <Badge tone="info">queued</Badge>}
        </p>
        <PreviewControls item={item} nameId={nameId} />
      </div>
    </li>
  );
}

function Filters({ items, filter, set }: { items: LibraryItem[]; filter: LibraryFilter; set: (f: LibraryFilter) => void }) {
  // A chip counts what choosing it would show under the other filters (a component under every kind it serves).
  const { all, kinds: counts } = filterCounts(items, filter);
  const kinds = [...new Set([...KIND_ORDER.filter((k) => counts[k]), ...Object.keys(counts).filter((k) => !isKind(k)), ...(filter.kind !== 'all' ? [filter.kind] : [])])];
  const id = useId();
  return (
    <div className="lib-filters" data-testid="lib-filters">
      <fieldset className="chips">
        <legend className="label">Kind</legend>
        {['all', ...kinds].map((k) => (
          <label key={k} className={filter.kind === k ? 'chip current' : 'chip'}>
            <input type="radio" name={`${id}-kind`} value={k} checked={filter.kind === k} onChange={() => set({ ...filter, kind: k })} />
            {k === 'all' ? `All (${all})` : `${kindHeading(k)} (${counts[k] ?? 0})`}
          </label>
        ))}
      </fieldset>
      <fieldset className="chips">
        <legend className="label">Source</legend>
        {(['all', 'builtin', 'workspace'] as const).map((s) => (
          <label key={s} className={filter.source === s ? 'chip current' : 'chip'}>
            <input type="radio" name={`${id}-source`} value={s} checked={filter.source === s} onChange={() => set({ ...filter, source: s })} />
            {s === 'all' ? 'All' : SOURCE_WORDS[s].badge}
          </label>
        ))}
      </fieldset>
      <label className="field lib-find">
        <span className="label">Find</span>
        <input type="search" className="search-input" value={filter.text} placeholder="Name, id or description" maxLength={200} onChange={(e) => set({ ...filter, text: e.target.value })} data-testid="lib-find" />
      </label>
    </div>
  );
}

function Notices({ notices }: { notices: LibraryViewAnswer['notices'] }) {
  if (!notices.length) return null;
  const errors = notices.filter((n) => n.severity === 'error').length;
  return (
    <details className="lib-notices" data-testid="lib-notices">
      <summary>
        {plural(notices.length, 'registry notice')}
        {errors ? ` — ${plural(errors, 'component')} cannot be loaded` : ''}
      </summary>
      <ul>
        {notices.map((n, i) => (
          <li key={i}>
            <Badge tone={n.severity === 'error' ? 'danger' : 'warning'}>{n.severity === 'error' ? 'not loadable' : 'warning'}</Badge> {n.id && <Txt className="mono" text={n.id} />}{' '}
            <Txt text={n.untrusted.message} />
            {n.issues > 0 && <span className="muted small"> ({plural(n.issues, 'issue')})</span>}
            {n.command && (
              <>
                {' '}
                <code className="copyable small">
                  <Txt text={n.command} />
                </code>
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ThemeSwitcher({ view, slug }: { view: LibraryViewAnswer; slug: string }) {
  const id = useId();
  return (
    <label className="field lib-theme" htmlFor={id}>
      <span className="label">Theme</span>
      <select id={id} value={view.theme.name} data-testid="lib-theme" onChange={(e) => (location.hash = hrefTo({ name: 'library', slug, theme: e.target.value }))}>
        {view.themes.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name}
            {t.default ? " — the project's theme" : ''}
            {t.source === 'starter' ? ' (starter)' : t.source === 'project' ? ' (project folder)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

/** "Create with Claude": a prompt to copy into Claude Code; the Studio calls no model. */
function CreateDialog({ slug, theme, taken, kind: firstKind, like, onClose }: { slug: string; theme: string; taken: string[]; kind?: string; like?: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const [kind, setKind] = useState(isKind(firstKind) ? firstKind : 'card');
  const [id, setId] = useState('');
  const [words, setWords] = useState('');
  // L5.2b (review B L7): the person's words, kept in this tab only, are unsaved text the desktop app's quit question names.
  useUnsavedMark(words.trim() ? { kind: 'component_brief', project: slug } : null);
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const ids = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  const problem = id ? idProblem(id, taken) : null;
  const made = !problem && id ? createPrompt({ kind, id, project: slug, theme, description: words, ...(like ? { like } : {}) }) : null;
  const copy = () => {
    if (!made) return;
    const fail = () => {
      setCopied('failed');
      text.current?.select();
    };
    try {
      navigator.clipboard.writeText(made.prompt).then(() => setCopied('yes'), fail);
    } catch {
      fail();
    }
  };
  return (
    <dialog
      ref={ref}
      className="confirm-dialog lib-create"
      aria-labelledby={`${ids}-h`}
      data-testid="lib-create"
      onCancel={(e) => {
        e.preventDefault();
        ref.current?.close();
        onClose();
      }}
    >
      <h2 id={`${ids}-h`} className="card-title">
        Create a component with Claude
      </h2>
      <p className="small">
        The Studio writes no code and calls no model: copy this prompt into Claude Code (with the Demo Studio plugin). The new component appears here when its folder is written.
      </p>
      <fieldset className="chips">
        <legend className="label">Kind</legend>
        {KIND_ORDER.map((k) => (
          <label key={k} className={kind === k ? 'chip current' : 'chip'}>
            <input type="radio" name={`${ids}-kind`} value={k} checked={kind === k} onChange={() => setKind(k)} />
            {kindHeading(k, 1)}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="label">Id (namespace/name)</span>
        <input className="search-input mono" value={id} maxLength={120} placeholder="acme/intro-split" onChange={(e) => setId(e.target.value.trim())} aria-invalid={problem ? true : undefined} aria-describedby={`${ids}-why`} data-testid="lib-create-id" />
        <span id={`${ids}-why`} className="small" role="status">
          {problem ?? ' '}
        </span>
      </label>
      <label className="field">
        <span className="label">What it should do (your words; kept in this tab only)</span>
        <textarea rows={3} maxLength={2000} value={words} onChange={(e) => setWords(e.target.value)} data-testid="lib-create-words" />
      </label>
      {made ? (
        <>
          <label className="field">
            <span className="label">The prompt</span>
            <textarea ref={text} readOnly rows={6} value={made.prompt} data-testid="lib-create-prompt" />
          </label>
          <p className="small">
            Or scaffold it yourself in a terminal, in the workspace folder: <code className="copyable" data-testid="lib-create-command">{made.command}</code>
          </p>
        </>
      ) : (
        <p className="small muted">Give it a kind and an id: the prompt shows here.</p>
      )}
      <div className="actions">
        <button type="button" className="button primary" disabled={!made} onClick={copy} data-testid="lib-create-copy">
          Copy the prompt
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            ref.current?.close();
            onClose();
          }}
        >
          Close
        </button>
        <span className="small" role="status" aria-live="polite" data-testid="lib-create-copied">
          {copied === 'yes' ? 'Copied.' : copied === 'failed' ? 'Copying was refused: the prompt is selected — copy it with ⌘C.' : ''}
        </span>
      </div>
    </dialog>
  );
}

type SetState =
  | { s: 'idle' }
  | { s: 'busy'; what: string }
  | { s: 'plan'; view: ThemeEditView; plan: SetDefaultPlan; kind: string }
  | { s: 'done'; theme: string; before: ThemeEditView; result: ThemeEditResult; copied?: string }
  | { s: 'undone'; theme: string }
  | { s: 'error'; message: string };

/**
 * "Set as theme default": theme_view of the selected theme → one `set_component` through theme_edit (if_match the view's
 * sha256), confirmed first; undo restores the exact bytes shown (theme_edit `restore`). A starter or a read-only theme
 * is copied first (theme_copy), then the copy is changed and the library switches to it.
 */
function SetDefault({ item, view }: { item: LibraryItem; view: LibraryViewAnswer }) {
  const lib = useLibrary();
  const kinds = kindsOf(item).filter(isKind);
  const [kind, setKind] = useState<string>(kinds[0] ?? item.kind);
  const [st, setSt] = useState<SetState>({ s: 'idle' });
  const [copyAs, setCopyAs] = useState(() => copyName(view.theme.name, view.themes.map((t) => t.name)));
  const ids = useId();
  const theme = view.theme.name;
  const fail = (e: unknown) => {
    if (e instanceof SessionEnded) return;
    setSt({ s: 'error', message: e instanceof CallError && e.error.code === 'conflict' ? 'The theme changed meanwhile: nothing was written. Try again.' : errorText(e) });
  };
  const start = async () => {
    setSt({ s: 'busy', what: 'Reading the theme…' });
    try {
      const tv = await call<ThemeEditView>('theme_view', { theme });
      setSt({ s: 'plan', view: tv, plan: setDefaultPlan(tv, kind, item.component), kind });
    } catch (e) {
      fail(e);
    }
  };
  const write = async (target: string, tv: ThemeEditView, copied?: string) => {
    const plan = setDefaultPlan(tv, kind, item.component);
    if (!('edit' in plan)) {
      setSt({ s: 'plan', view: tv, plan, kind });
      return;
    }
    setSt({ s: 'busy', what: 'Writing the theme…' });
    const result = await call<ThemeEditResult>('theme_edit', { theme: target, if_match: tv.sha256, edit: plan.edit });
    setSt({ s: 'done', theme: target, before: tv, result, ...(copied ? { copied } : {}) });
    if (copied) location.hash = hrefTo({ name: 'library', slug: lib.slug, theme: copied, component: item.component });
    else lib.reload();
  };
  const copyThenWrite = async () => {
    const problem = themeNameProblem(copyAs, view.themes.map((t) => t.name));
    if (problem) return setSt({ s: 'error', message: problem });
    setSt({ s: 'busy', what: `Copying ${theme} to ${copyAs}…` });
    try {
      const c = await call<{ name: string }>('theme_copy', { from: theme, name: copyAs });
      const tv = await call<ThemeEditView>('theme_view', { theme: c.name });
      await write(c.name, tv, c.name);
    } catch (e) {
      fail(e);
    }
  };
  const undo = async (d: Extract<SetState, { s: 'done' }>) => {
    if (d.before.yaml === null) return;
    setSt({ s: 'busy', what: 'Undoing…' });
    try {
      await call<ThemeEditResult>('theme_edit', { theme: d.theme, if_match: d.result.sha256, edit: { kind: 'restore', text: d.before.yaml, text_hash: d.before.sha256 } });
      setSt({ s: 'undone', theme: d.theme });
      lib.reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <section className="card lib-set" aria-labelledby={`${ids}-h`} data-testid="lib-set-default">
      <h2 id={`${ids}-h`} className="card-title">
        Theme default
      </h2>
      {item.theme_default.length > 0 ? (
        <p className="small">
          <Txt text={theme} /> uses it by default as its {item.theme_default.join(', ')}.
        </p>
      ) : (
        <p className="small muted">
          <Txt text={theme} /> does not use it by default.
        </p>
      )}
      {kinds.length > 1 && (
        <label className="field">
          <span className="label">As the theme's</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} data-testid="lib-set-kind">
            {kinds.map((k) => (
              <option key={k} value={k}>
                {kindHeading(k, 1).toLowerCase()}
              </option>
            ))}
          </select>
        </label>
      )}
      {(st.s === 'idle' || st.s === 'undone' || st.s === 'error') && (
        <div className="actions">
          <button type="button" className="button" onClick={() => void start()} data-testid="lib-set-start">
            Set as default of {theme}…
          </button>
          {okTheme(theme) && (
            <a className="button quiet" href={hrefTo({ name: 'themes', slug: lib.slug, theme })} data-testid="lib-set-editor">
              Open the theme editor
            </a>
          )}
        </div>
      )}
      <div role="status" aria-live="polite" className="small" data-testid="lib-set-state">
        {st.s === 'busy' && st.what}
        {st.s === 'undone' && (
          <>
            Undone: <Txt text={st.theme} /> is back to the version before.
          </>
        )}
        {st.s === 'error' && (
          <span className="lib-failure">
            <Txt text={st.message} />
          </span>
        )}
        {st.s === 'done' && (
          <>
            <Txt text={st.result.label} />
            {st.result.removed.length > 0 && <> — removed {st.result.removed.join(', ')} (they contradicted it)</>}.
            {st.copied && (
              <>
                {' '}
                The copy <Txt text={st.copied} /> is a new theme: the project still uses its own until <code>template:</code> names the copy (in project.yaml, or per scenario).
              </>
            )}
          </>
        )}
      </div>
      {st.s === 'done' && (
        <div className="actions">
          {st.before.yaml !== null ? (
            <button type="button" className="button small" onClick={() => void undo(st)} data-testid="lib-set-undo">
              Undo
            </button>
          ) : (
            <span className="small muted">No undo: the theme's file was not shown whole.</span>
          )}
          {st.copied && okTheme(st.copied) && (
            // The next step (review B L5): the copy is used once a scenario or the project names it.
            <a className="button small primary" href={hrefTo({ name: 'themes', slug: lib.slug, theme: st.copied })} data-testid="lib-set-next">
              Open the copy: use it in a scenario
            </a>
          )}
          {st.result.warnings.map((w, i) => (
            <span key={i} className="small muted">
              <Txt text={w} />
            </span>
          ))}
        </div>
      )}
      {st.s === 'plan' && 'edit' in st.plan && (
        <div className="lib-confirm" data-testid="lib-set-confirm">
          <p>{setDefaultWords(theme, st.kind, item.component, st.plan)}</p>
          <div className="actions">
            <button type="button" className="button primary" data-testid="lib-set-confirm-yes" onClick={() => void write(theme, st.view).catch(fail)}>
              Set as default
            </button>
            <button type="button" className="button" onClick={() => setSt({ s: 'idle' })}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {st.s === 'plan' && 'already' in st.plan && (
        <p className="small" data-testid="lib-set-already">
          It is already the {st.kind} of <Txt text={theme} />.
        </p>
      )}
      {st.s === 'plan' && 'why' in st.plan && (
        <p className="small lib-failure" data-testid="lib-set-why">
          <Txt text={st.plan.why} />
        </p>
      )}
      {st.s === 'plan' && 'copy' in st.plan && (
        <div className="lib-confirm" data-testid="lib-set-copy">
          <p className="small">
            <Txt text={theme} /> cannot be changed here (<Txt text={st.plan.copy} />
            ). Copy it to a theme of this workspace, then set the default there:
          </p>
          <label className="field">
            <span className="label">Name of the copy</span>
            <input className="search-input mono" value={copyAs} maxLength={100} onChange={(e) => setCopyAs(e.target.value.trim())} data-testid="lib-set-copy-name" />
          </label>
          <div className="actions">
            <button type="button" className="button primary" data-testid="lib-set-copy-yes" onClick={() => void copyThenWrite()}>
              Copy and set as default
            </button>
            <button type="button" className="button" onClick={() => setSt({ s: 'idle' })}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Facts({ d, item }: { d: LibraryComponentAnswer; item: LibraryItem }) {
  return (
    <dl className="lib-facts" data-testid="lib-facts">
      <dt>Kind</dt>
      <dd>
        {d.kind}
        {d.kinds?.length ? <span className="muted"> · also usable as {d.kinds.join(', ')}</span> : null}
      </dd>
      <dt>Version</dt>
      <dd className="mono">{d.version}</dd>
      <dt>Source</dt>
      <dd>
        <SourceBadge source={d.source} /> <span className="small muted">{SOURCE_WORDS[d.source].title}</span>
        {d.overrides_builtin && <span className="small"> It replaces the built-in of the same id in every render.</span>}
      </dd>
      <dt>Kit</dt>
      <dd data-testid="lib-kit">
        Kit API {d.kit.needs}: {d.kit.compatible ? `works with this Demo Studio (kit API ${d.kit.provided})` : `this Demo Studio provides kit API ${d.kit.provided} — it does not load`}
      </dd>
      {d.duration && (
        <>
          <dt>Duration</dt>
          <dd>
            {d.duration.default} s{d.duration.min !== undefined || d.duration.max !== undefined ? ` (from ${d.duration.min ?? '—'} to ${d.duration.max ?? '—'} s)` : ''}
          </dd>
        </>
      )}
      <dt>Formats</dt>
      <dd>{d.variants.join(', ')}</dd>
      <dt>Used by</dt>
      <dd>{item.picked_by.length ? item.picked_by.join(', ') : <span className="muted">no theme of this project picks it</span>}</dd>
    </dl>
  );
}

function Slots({ d }: { d: LibraryComponentAnswer }) {
  if (!d.slots.length) return <p className="small muted">No slots.</p>;
  return (
    <table className="pages lib-table" data-testid="lib-slots">
      <caption className="sr-only">Slots</caption>
      <thead>
        <tr>
          <th scope="col">Slot</th>
          <th scope="col">Type</th>
          <th scope="col">Required</th>
          <th scope="col">Default from</th>
          <th scope="col">Max</th>
          <th scope="col">What it is</th>
        </tr>
      </thead>
      <tbody>
        {d.slots.map((s) => (
          <tr key={s.name}>
            <th scope="row">
              <Txt className="mono" text={s.name} />
            </th>
            <td>{s.type}</td>
            <td>{s.required ? 'yes' : 'no'}</td>
            <td>{s.default_from ? <Txt className="mono" text={s.default_from} /> : <span className="muted">—</span>}</td>
            <td>{s.max_chars ?? <span className="muted">—</span>}</td>
            <td>{d.untrusted.slots[s.name] ? <Txt text={d.untrusted.slots[s.name]} /> : <span className="muted">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Params({ d }: { d: LibraryComponentAnswer }) {
  const ps = d.untrusted.params;
  if (!ps.length) return <p className="small muted">No params.</p>;
  return (
    <table className="pages lib-table" data-testid="lib-params">
      <caption className="sr-only">Params</caption>
      <thead>
        <tr>
          <th scope="col">Param</th>
          <th scope="col">Type</th>
          <th scope="col">Default</th>
          <th scope="col">Values</th>
          <th scope="col">What it does</th>
        </tr>
      </thead>
      <tbody>
        {ps.map((p, i) => (
          <tr key={i}>
            <th scope="row">
              <Txt className="mono" text={p.name} />
            </th>
            <td>{p.type ? <Txt text={p.type} /> : <span className="muted">—</span>}</td>
            <td>{p.default !== undefined ? <Txt className="mono" text={p.default} /> : <span className="muted">—</span>}</td>
            <td>
              {p.enum ? <Txt className="mono" text={p.enum.join(' | ')} /> : p.minimum !== undefined || p.maximum !== undefined ? `${p.minimum ?? '…'} to ${p.maximum ?? '…'}` : <span className="muted">—</span>}
            </td>
            <td>{p.description ? <Txt text={p.description} /> : <span className="muted">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Detail({ item, view, onCreate }: { item: LibraryItem; view: LibraryViewAnswer; onCreate: (kind: string, like: string) => void }) {
  const lib = useLibrary();
  const [d] = useCall<LibraryComponentAnswer>('library_component', { project: lib.slug, component: item.component }, `${lib.slug}/${item.component}/${item.version}/${item.poster.key}`);
  // Opening a component asks for its loop (rendered, not played: loops never start by themselves).
  useEffect(() => lib.pump.wantLoops([item.component]), [lib.pump, item.component]);
  const nameId = useId();
  return (
    <div className="lib-detail" data-testid="lib-detail">
      <header className="screen-head">
        <h1 id={nameId}>
          <Txt text={item.untrusted.name} />
        </h1>
        <p className="muted">
          <Txt className="mono" text={item.component} /> · {kindHeading(item.kind, 1)} · in <Txt text={view.theme.name} />
        </p>
        <p className="lib-badges">
          <SourceBadge source={item.source} />
          <DefaultBadges item={item} theme={view.theme.name} />
        </p>
      </header>
      <div className="lib-detail-grid">
        <div className="stack">
          <PictureBox item={item} large />
          <PreviewControls item={item} nameId={nameId} />
          <p className="small">
            <Txt text={item.untrusted.description} />
          </p>
        </div>
        <div className="stack">
          <SetDefault key={item.component} item={item} view={view} />
          <section className="card">
            <h2 className="card-title">A new one like it</h2>
            <p className="small muted">A prompt for Claude Code's component skill, to copy. The Studio calls no model.</p>
            <div className="actions">
              <button type="button" className="button" onClick={() => onCreate(item.kind, item.component)} data-testid="lib-detail-create">
                Create with Claude…
              </button>
            </div>
          </section>
        </div>
      </div>
      {d.state === 'loading' && <Loading what="the component" />}
      {d.state === 'error' && (
        <Notice tone="danger" role="alert" title="This component cannot be read">
          <p>
            <Txt text={d.error} />
          </p>
        </Notice>
      )}
      {d.state === 'ready' && (
        <>
          <section className="card">
            <h2 className="card-title">About</h2>
            <Facts d={d.data} item={item} />
          </section>
          <section className="card">
            <h2 className="card-title">Slots</h2>
            <Slots d={d.data} />
          </section>
          <section className="card">
            <h2 className="card-title">Params</h2>
            <Params d={d.data} />
          </section>
          {d.data.untrusted.readme !== undefined && (
            <section className="card">
              <h2 className="card-title">README</h2>
              <pre className="readme-text" data-testid="lib-readme">
                <Txt text={d.data.untrusted.readme} />
              </pre>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Breadcrumb({ slug, theme, component }: { slug: string; theme?: string; component?: string }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <a href={hrefTo({ name: 'projects' })}>Projects</a>
      <span aria-hidden="true"> / </span>
      <a href={hrefTo({ name: 'project', slug })}>
        <Txt text={slug} />
      </a>
      <span aria-hidden="true"> / </span>
      {component ? (
        <>
          <a href={hrefTo({ name: 'library', slug, ...(theme ? { theme } : {}) })}>Components</a>
          <span aria-hidden="true"> / </span>
          <Txt aria-current="page" text={component} />
        </>
      ) : (
        <span aria-current="page">Components</span>
      )}
    </nav>
  );
}

export function LibraryScreen({ slug, theme, component }: { slug: string; theme?: string; component?: string }) {
  const args = useMemo(() => ({ project: slug, ...(theme ? { theme } : {}) }), [slug, theme]);
  const [view, reload] = useCall<LibraryViewAnswer>('library_view', args, `${slug}/${theme ?? ''}`);
  const [filter, setFilter] = useState<LibraryFilter>(NO_FILTER);
  const [playing, setPlayingSet] = useState<ReadonlySet<string>>(new Set());
  const [create, setCreate] = useState<{ kind?: string; like?: string } | null>(null);
  const themeRef = useRef('');
  // The last view stays on screen while another theme's loads (a copy made by "Set as theme default" keeps its Undo).
  const last = useRef<LibraryViewAnswer | null>(null);
  if (view.state === 'ready') {
    themeRef.current = view.data.theme.name;
    last.current = view.data;
  }
  const pump = useMemo(
    () =>
      new RenderPump({
        send: async (req: RenderRequest) => {
          try {
            await call('library_render', { project: slug, theme: themeRef.current, ...req });
          } catch (e) {
            if (e instanceof SessionEnded) return;
            throw new Error(errorText(e));
          }
          reload();
        },
      }),
    // One pump per screen (the screen is keyed by project): the theme travels in its views.
    [slug],
  );
  usePump(pump);
  const images = useMemo(
    () =>
      new LibraryImages((keys, committed, signal) => call<LibraryImagesAnswer>('library_images', { project: slug, keys, ...(committed.length ? { committed } : {}) }, { signal })),
    [slug],
  );
  const observer = useMemo(() => {
    const callbacks = new Map<Element, (visible: boolean) => void>();
    let io: IntersectionObserver | null = null;
    const get = () =>
      (io ??= new IntersectionObserver(
        (entries) => {
          for (const e of entries) callbacks.get(e.target)?.(e.isIntersecting);
        },
        { rootMargin: '100px 0px' },
      ));
    return {
      observe(el: Element, on: (v: boolean) => void) {
        callbacks.set(el, on);
        get().observe(el);
        return () => {
          callbacks.delete(el);
          io?.unobserve(el);
        };
      },
      close: () => io?.disconnect(),
    };
  }, []);
  useEffect(
    () => () => {
      images.close();
      pump.stop();
      observer.close();
    },
    [images, pump, observer],
  );
  // The tab hidden: nothing is queued (B8).
  useEffect(() => {
    const on = () => pump.setActive(document.visibilityState !== 'hidden');
    on();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [pump]);
  useEffect(() => {
    if (view.state === 'ready') pump.setView(view.data.theme.name, view.data.items, view.data.queued);
  }, [view, pump]);
  // Live re-reads: a theme, a component, the project changed; a job while previews are queued (B5, B8).
  const timer = useRef<number | null>(null);
  useEvents((e) => {
    const busy = view.state === 'ready' && (view.data.queued > 0 || view.data.items.some((i) => pump.askedOf(i.poster.key) === 'pending' || pump.askedOf(i.loop.key) === 'pending'));
    if (!libraryEventAction(e, slug, { busy })) return;
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      reload();
    }, REREAD_MS);
  });
  useEffect(() => () => void (timer.current !== null && window.clearTimeout(timer.current)), []);
  const setPlaying = useCallback((c: string, on: boolean) => {
    setPlayingSet((s) => {
      const n = new Set(s);
      if (on) n.add(c);
      else n.delete(c);
      return n;
    });
  }, []);
  if (view.state === 'loading' && !last.current) {
    return (
      <div className="screen library-screen">
        <Breadcrumb slug={slug} />
        <Loading what="the components" />
      </div>
    );
  }
  if (view.state === 'error') {
    return (
      <div className="screen library-screen">
        <Breadcrumb slug={slug} />
        <Notice tone="danger" role="alert" title="The library cannot be shown">
          <p className="pre-line">
            <Txt text={view.error} />
          </p>
          {theme && (
            <p>
              <a href={hrefTo({ name: 'library', slug })}>Show it in the project's theme</a>
            </p>
          )}
        </Notice>
      </div>
    );
  }
  const v = view.state === 'ready' ? view.data : last.current!;
  const ctx: LibraryCtx = { slug, theme: v.theme.name, images, pump, playing, setPlaying, reload, observe: observer.observe };
  const shown = filterItems(v.items, filter);
  const groups = groupByKind(shown, filter.kind);
  const item = component ? v.items.find((i) => i.component === component) : undefined;
  const loopsToRender = shown.filter((i) => i.loop.state === 'missing' && !i.loop.queued).map((i) => i.component);
  return (
    <Ctx.Provider value={ctx}>
      <div className="screen library-screen" data-testid="library" data-theme={v.theme.name}>
        <Breadcrumb slug={slug} theme={v.theme.name} {...(component ? { component } : {})} />
        {component ? (
          item ? (
            <Detail item={item} view={v} onCreate={(kind, like) => setCreate({ kind, like })} />
          ) : (
            <Notice tone="warning" role="alert" title="No such component in the library">
              <p>
                <Txt className="mono" text={component} /> is not a usable component of this workspace (the registry notices say why when it does not load).
              </p>
              <p>
                <a href={hrefTo({ name: 'library', slug, theme: v.theme.name })}>Back to the components</a>
              </p>
            </Notice>
          )
        ) : (
          <>
            <header className="screen-head lib-head">
              <h1>Components</h1>
              <p className="muted">
                {plural(v.items.length, 'component')} in <Txt text={v.theme.name} />
                {v.theme.project_default ? ", the project's theme" : ''}. Posters render when their cards are on screen; Play shows the component moving.
              </p>
            </header>
            <div className="lib-bar">
              <ThemeSwitcher view={v} slug={slug} />
              <div className="actions">
                {okTheme(v.theme.name) && (
                  <a className="button" href={hrefTo({ name: 'themes', slug, theme: v.theme.name })} data-testid="lib-theme-editor">
                    Open the theme editor
                  </a>
                )}
                <button type="button" className="button" disabled={!loopsToRender.length} onClick={() => pump.wantLoops(loopsToRender, false)} data-testid="lib-render-all">
                  Render all loops{loopsToRender.length ? ` (${loopsToRender.length})` : ''}
                </button>
                <button type="button" className="button primary" onClick={() => setCreate({})} data-testid="lib-create-open">
                  Create with Claude…
                </button>
              </div>
            </div>
            <p className="small" role="status" aria-live="polite" data-testid="lib-status">
              {v.queued > 0 ? `${plural(v.queued, 'preview')} queued: waiting for the worker (a capture queued first runs first).` : ''}
            </p>
            {pump.error && (
              <Notice tone="warning" role="alert" title="No preview was queued">
                <p>
                  <Txt text={pump.error} />
                </p>
                <button type="button" className="button small" onClick={() => pump.clearError()} data-testid="lib-try-again">
                  Try again
                </button>
              </Notice>
            )}
            {v.job_error && (
              <Notice tone="warning" role="alert" title="The last preview job failed">
                <p className="pre-line" data-testid="lib-job-error">
                  <Txt text={v.job_error.untrusted.message} />
                </p>
                <p className="small muted">Its cards say "Render again"; a component that does not load is named in the registry notices.</p>
              </Notice>
            )}
            <Notices notices={v.notices} />
            <Filters items={v.items} filter={filter} set={setFilter} />
            {groups.length === 0 && <p className="muted">No component matches.</p>}
            {groups.map((g) => (
              <section key={g.kind} className="lib-section" aria-labelledby={`lib-h-${g.kind}`}>
                <div className="lib-section-head">
                  <h2 id={`lib-h-${g.kind}`} className="lib-section-title">
                    {kindHeading(g.kind)} <span className="muted">({g.items.length})</span>
                  </h2>
                  {filter.kind === 'all' && alsoServing(shown, g.kind) > 0 && (
                    <button type="button" className="button small quiet" onClick={() => setFilter({ ...filter, kind: g.kind })} data-testid="lib-also-serving">
                      {alsoServingWords(alsoServing(shown, g.kind))}
                    </button>
                  )}
                </div>
                <ul className="lib-grid">
                  {g.items.map((i) => (
                    <Card key={i.component} item={i} />
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
        {create && (
          <CreateDialog
            slug={slug}
            theme={v.theme.name}
            taken={v.items.map((i) => i.component)}
            {...(create.kind ? { kind: create.kind } : {})}
            {...(create.like ? { like: create.like } : {})}
            onClose={() => setCreate(null)}
          />
        )}
      </div>
    </Ctx.Provider>
  );
}
