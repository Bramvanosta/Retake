/**
 * The component library (R-UI-06 / R-UI-06b, R-UI-49 — `#/p/<slug>/library[/<theme>[/<ns>/<name>]]`): every usable
 * component of the workspace by kind, each card the component's poster in the selected theme (the project's by
 * default), its source in words ("Built-in" / "Workspace"), "Theme default" for the theme's picks, and Play — the
 * component's looping GIF in place of the poster (loops never start by themselves).
 *
 * In the shell:
 * - browser: the Library group (Components, Themes) and the project's themes (LibraryBrowser.tsx);
 * - title bar (context): the Theme select (`lib-theme`);
 * - centre: "Components · n in <theme>", Create with Claude…, the Source segmented control, the search, the Kind chips
 *   (each counts what choosing it would show: "All (41)", "Intros (4)"), the registry notices, then a section of poster
 *   cards per kind (LibraryCards.tsx); one component's page on its route (LibraryDetail.tsx);
 * - inspector: the selected card's (or the open component's) facts and actions — Play in the theme, Set as default…,
 *   Create with Claude…, About (LibraryInspector.tsx); nothing selected: the theme's summary;
 * - status bar: "Idle · Posters render while their cards are on screen", Render all loops, Open the theme editor.
 * Create with Claude is a kit Sheet (CreateSheet.tsx): the person's words are kept here, across a close and a reopen.
 * The component inspector is rendered at ONE place of the tree whether the grid or a component's page is
 * shown, keyed by the component ("Set as default" on a starter from the grid moves to the copy's page and keeps its
 * result, Undo and "Open the copy"); the card grid is one tab stop — the arrows move the selection
 * (← → one card, ↑ ↓ a row of the section, across sections), Home / End, Escape clears it, Enter on the selected card
 * takes the focus to its inspector (in place when the inspector is hidden).
 *
 * Safety: every manifest word (a workspace component's name, description, slot / param words, README) is agent-writable
 * text shown only through `Txt`, never in an attribute; pictures reach the one `<img>` only as checked data addresses; a
 * workspace component's code never runs here (its posters and loops are pixels from the worker's guarded render
 * browser). What the screen asks for and when: library-load.ts (cards on screen only, chunks of 12, a 2 s debounce,
 * Retry; nothing while the tab is hidden).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import type { LibraryItem, LibraryViewAnswer } from '../../server/library-ops.js';
import { errorText } from '../api.js';
import type { Loaded, OpResult } from '../api.js';
import { libraryImages, libraryRender, useLibraryComponent, useLibraryView } from '../data/library.js';
import { Txt, plural } from '../bits.js';
import { CreateSheet } from '../project/CreateSheet.js';
import type { Brief } from '../project/CreateSheet.js';
import { useUnsavedMark } from '../drafts.js';
import { useEvents } from '../events.js';
import { LibraryBrowser } from './LibraryBrowser.js';
import { LibraryCard, LibraryContext } from './LibraryCards.js';
import type { LibraryCtx } from './LibraryCards.js';
import { LibraryDetail } from './LibraryDetail.js';
import { ComponentInspector, LibraryInspector } from './LibraryInspector.js';
import { LibraryImages, RenderPump } from './library-load.js';
import type { RenderRequest } from './library-load.js';
import { Filters, Notices, ThemeSelect } from './library-controls.js';
import { gridKeyHandler, gridTabStop, useSelection } from './library-grid-keys.js';
import { NO_FILTER, alsoServing, alsoServingWords, filterItems, groupByKind, isKind, kindHeading, libraryEventAction, okTheme } from '../words/library-words.js';
import type { LibraryFilter } from '../words/library-words.js';
import { SessionEnded } from '../session.js';
import { ShellSlot } from '../shell/slots.js';
import { ToolsNeeded } from '../shell/tools-parts.js';
import { Button, Callout, LinkButton, StatusMark } from '../ui-kit/index.js';

export { nextCard } from './library-grid-keys.js';

/** Events re-read the view at most this often. */
const REREAD_MS = 250;
const NO_BRIEF: Brief = { kind: 'card', id: '', words: '' };

/**
 * The on-screen observer: one IntersectionObserver per scroller — the shell's centre pane for the boxes inside it (the
 * grid, the detail; the inspector shown in place), the window for the others (the inspector pane's picture: an observer
 * rooted at the centre pane would never see it).
 */
function useObserver() {
  const o = useMemo(() => {
    const callbacks = new Map<Element, (visible: boolean) => void>();
    const ios = new Map<Element | null, IntersectionObserver>();
    const get = (root: Element | null) => {
      let io = ios.get(root);
      if (!io) {
        io = new IntersectionObserver(
          (entries) => {
            for (const e of entries) callbacks.get(e.target)?.(e.isIntersecting);
          },
          { root, rootMargin: '100px 0px' },
        );
        ios.set(root, io);
      }
      return io;
    };
    return {
      observe(el: Element, on: (v: boolean) => void) {
        const main = document.getElementById('main');
        const io = get(main?.contains(el) ? main : null);
        callbacks.set(el, on);
        io.observe(el);
        return () => {
          callbacks.delete(el);
          io.unobserve(el);
        };
      },
      close: () => {
        for (const io of ios.values()) io.disconnect();
        ios.clear();
      },
    };
  }, []);
  return o;
}

/** The selected or open component: its manifest read once (library_component) for the inspector and the page. */
function Focused({ item, view, playing, detail, onCreate }: { item: LibraryItem; view: LibraryViewAnswer; playing: boolean; detail: boolean; onCreate: (kind: string, like: string) => void }) {
  const [d] = useLibraryComponent({ project: view.project, component: item.component }, `${view.project}/${item.component}/${item.version}/${item.poster.key}`);
  return (
    <>
      {detail && <LibraryDetail item={item} view={view} d={d} playing={playing} />}
      <ShellSlot name="inspector" inline="Component">
        <ComponentInspector item={item} view={view} d={d} playing={playing} detail={detail} onCreate={onCreate} />
      </ShellSlot>
    </>
  );
}

/** Opening a component's page asks for its loop (rendered, not played: loops never start by themselves). */
function WantLoop({ pump, component }: { pump: RenderPump; component: string }) {
  useEffect(() => pump.wantLoops([component]), [pump, component]);
  return null;
}

type ViewRead = Loaded<OpResult<'library_view'>>;

/** The screen's render pump, picture loader and on-screen observer, closed with the screen; the pump follows the view. */
function useLibraryLoaders(slug: string, view: ViewRead, reload: () => void, themeRef: { current: string }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: one pump per screen (keyed by project); `reload` is useCall's, stable for the screen's life
  const pump = useMemo(
    () =>
      new RenderPump({
        send: async (req: RenderRequest) => {
          try {
            await libraryRender({ project: slug, theme: themeRef.current, ...req });
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
  const pumpError = useSyncExternalStore(
    useCallback((fn: () => void) => pump.subscribe(fn), [pump]),
    () => pump.error,
  );
  const images = useMemo(() => new LibraryImages((keys, committed, signal) => libraryImages({ project: slug, keys, ...(committed.length ? { committed } : {}) }, { signal })), [slug]);
  const observer = useObserver();
  useEffect(
    () => () => {
      images.close();
      pump.stop();
      observer.close();
    },
    [images, pump, observer],
  );
  // The tab hidden: nothing is queued.
  useEffect(() => {
    const on = () => pump.setActive(document.visibilityState !== 'hidden');
    on();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [pump]);
  useEffect(() => {
    if (view.state === 'ready') pump.setView(view.data.theme.name, view.data.items, view.data.queued);
  }, [view, pump]);
  return { pump, pumpError, images, observer };
}

/** Live re-reads: a theme, a component, the project changed; a job while previews are queued. */
function useLiveRereads(slug: string, view: ViewRead, pump: RenderPump, reload: () => void) {
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
}

/** No view yet: the load's error, or its progress. */
function LibraryUnavailable({ view, slug, theme }: { view: ViewRead; slug: string; theme?: string }) {
  return (
    <div className="lb-screen" data-testid="library">
      {view.state === 'error' && <h1 className="lb-h1">Components</h1>}
      {view.state === 'error' ? (
        <Callout state="fail" role="alert" title="The library cannot be shown">
          <p className="lb-pre">
            <Txt text={view.error} />
          </p>
          {theme && (
            <LinkButton size="sm" to={{ name: 'library', slug }}>
              Show it in the project's theme
            </LinkButton>
          )}
        </Callout>
      ) : (
        <p className="lb-quiet" role="status">
          Loading the components…
        </p>
      )}
    </div>
  );
}

/** The status bar: the queue's state, Render all loops, Open the theme editor. */
function LibraryActions({ v, slug, pump, loopsToRender }: { v: LibraryViewAnswer; slug: string; pump: RenderPump; loopsToRender: string[] }) {
  return (
    <ShellSlot name="actions">
      <span className="sh-scenario" role="status" data-testid="lib-status">
        {v.queued > 0 ? <StatusMark state="running" word={`${plural(v.queued, 'preview')} queued: waiting for the worker`} /> : <StatusMark state="idle" word="Idle" />}
        <span className="sh-seg" data-drop="when">
          {' · Posters render while their cards are on screen'}
        </span>
      </span>
      <Button size="sm" variant="ghost" disabled={!loopsToRender.length} onClick={() => pump.wantLoops(loopsToRender, false)} data-testid="lib-render-all">
        <Txt text={`Render all loops${loopsToRender.length ? ` (${loopsToRender.length})` : ''}`} />
      </Button>
      {okTheme(v.theme.name) && (
        <LinkButton size="sm" variant="ghost" to={{ name: 'themes', slug, theme: v.theme.name }} testId="lib-theme-editor">
          Open the theme editor
        </LinkButton>
      )}
    </ShellSlot>
  );
}

/** The pump's error (with Try again) and the last preview job's failure. */
function LibraryAlerts({ v, pump, pumpError }: { v: LibraryViewAnswer; pump: RenderPump; pumpError: string | null }) {
  return (
    <>
      {/* Posters and loops are rendered (preview jobs): they wait for the render tools. */}
      <ToolsNeeded need="render" what="Rendering the components' posters and loops" testId="library-tools" />
      {pumpError && (
        <Callout state="warn" role="alert" title="No preview was queued">
          <Txt text={pumpError} />{' '}
          <Button size="sm" onClick={() => pump.clearError()} data-testid="lib-try-again">
            Try again
          </Button>
        </Callout>
      )}
      {v.job_error && (
        <Callout state="warn" role="alert" title="The last preview job failed">
          <p className="lb-pre" data-testid="lib-job-error">
            <Txt text={v.job_error.untrusted.message} />
          </p>
          <p className="lb-quiet">Its cards say "Render again"; a component that does not load is named in the registry notices.</p>
        </Callout>
      )}
    </>
  );
}

/** A component route naming no usable component. */
function NoSuchComponent({ component, slug, theme }: { component: string; slug: string; theme: string }) {
  return (
    <Callout state="warn" role="alert" title="No such component in the library">
      <Txt className="k-mono" text={component} />
      {' is not a usable component of this workspace (the registry notices say why when it does not load). '}
      <LinkButton size="sm" variant="ghost" to={{ name: 'library', slug, theme }}>
        Back to the components
      </LinkButton>
    </Callout>
  );
}

/** The grid page: the heading, the filters, the notices and a section of cards per kind. */
function LibraryGrid({
  v,
  filter,
  setFilter,
  shown,
  groups,
  selected,
  playing,
  tabStop,
  gridKeys,
  onCreate,
}: {
  v: LibraryViewAnswer;
  filter: LibraryFilter;
  setFilter: (f: LibraryFilter) => void;
  shown: LibraryItem[];
  groups: Array<{ kind: string; items: LibraryItem[] }>;
  selected: string | null;
  playing: ReadonlySet<string>;
  tabStop: string | null;
  gridKeys: (e: KeyboardEvent<HTMLDivElement>) => void;
  onCreate: () => void;
}) {
  return (
    <>
      <header className="lb-head">
        <h1 className="lb-h1">Components</h1>
        <Txt className="lb-count" text={`${v.items.length} in ${v.theme.name}${v.theme.project_default ? ", the project's theme" : ''}`} />
        <span className="lb-head-end">
          <Button size="sm" variant="primary" onClick={onCreate} data-testid="lib-create-open">
            Create with Claude…
          </Button>
        </span>
      </header>
      <Filters items={v.items} filter={filter} set={setFilter} />
      <Notices notices={v.notices} />
      {groups.length === 0 && <p className="lb-quiet">No component matches.</p>}
      {/* The grid: one tab stop; its keys move the selection (gridKeys). */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the keys bubble from the focused card (the grid's one tab stop); the wrapper itself is not a control */}
      <div className="lb-cards" onKeyDown={gridKeys}>
        {groups.map((g) => (
          <section key={g.kind} className="lb-section" data-testid="lib-section" data-kind={g.kind} aria-labelledby={`lb-h-${g.kind}`}>
            <div className="lb-section-head">
              <h2 id={`lb-h-${g.kind}`} className="lb-h2" data-testid="lib-section-title">
                <Txt text={kindHeading(g.kind)} /> <Txt className="lb-num" text={`(${g.items.length})`} />
              </h2>
              {filter.kind === 'all' && alsoServing(shown, g.kind) > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setFilter({ ...filter, kind: g.kind })} data-testid="lib-also-serving">
                  <Txt text={alsoServingWords(alsoServing(shown, g.kind))} />
                </Button>
              )}
            </div>
            <ul className="lb-grid">
              {g.items.map((i) => (
                <LibraryCard key={i.component} item={i} selected={i.component === selected} playing={playing.has(i.component)} tabStop={i.component === tabStop} testId="lib-card" />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

export function LibraryScreen({ slug, theme, component }: { slug: string; theme?: string; component?: string }) {
  const args = useMemo(() => ({ project: slug, ...(theme ? { theme } : {}) }), [slug, theme]);
  const [view, reload] = useLibraryView(args, `${slug}/${theme ?? ''}`);
  const [filter, setFilter] = useState<LibraryFilter>(NO_FILTER);
  const [playing, setPlayingSet] = useState<ReadonlySet<string>>(new Set());
  const { selected, cursor, select } = useSelection();
  const [creating, setCreating] = useState(false);
  const [brief, setBrief] = useState<Brief>(NO_BRIEF);
  // The person's words, kept in this tab only, are unsaved text the desktop app's quit question
  // names — held here: closing the sheet keeps them.
  useUnsavedMark(brief.words.trim() ? { kind: 'component_brief', project: slug } : null);
  const themeRef = useRef('');
  // The last view stays on screen while another theme's loads (a copy made by "Set as theme default" keeps its Undo).
  const last = useRef<LibraryViewAnswer | null>(null);
  if (view.state === 'ready') {
    themeRef.current = view.data.theme.name;
    last.current = view.data;
  }
  const { pump, pumpError, images, observer } = useLibraryLoaders(slug, view, reload, themeRef);
  useLiveRereads(slug, view, pump, reload);
  const setPlaying = useCallback((c: string, on: boolean) => {
    setPlayingSet((s) => {
      const n = new Set(s);
      if (on) n.add(c);
      else n.delete(c);
      return n;
    });
  }, []);
  const v = view.state === 'ready' ? view.data : last.current;
  const shownTheme = v?.theme.name ?? '';
  // One context object per theme: the memoised cards never re-render because the screen did.
  const ctx = useMemo<LibraryCtx>(
    () => ({ slug, theme: shownTheme, images, pump, setPlaying, select, reload, observe: observer.observe }),
    [slug, shownTheme, images, pump, setPlaying, select, reload, observer],
  );
  const shown = useMemo(() => (v ? filterItems(v.items, filter) : []), [v, filter]);
  const groups = useMemo(() => groupByKind(shown, filter.kind), [shown, filter.kind]);
  const openCreate = (kind?: string, like?: string) => {
    setBrief((b) => {
      const { like: _old, ...rest } = b;
      return { ...rest, ...(kind && isKind(kind) ? { kind } : {}), ...(like ? { like } : {}) };
    });
    setCreating(true);
  };

  if (!v) return <LibraryUnavailable view={view} slug={slug} theme={theme} />;

  const item = component ? v.items.find((i) => i.component === component) : undefined;
  const focus = component ? item : selected ? v.items.find((i) => i.component === selected) : undefined;
  const sections = groups.map((g) => g.items.map((i) => i.component));
  const tabStop = gridTabStop(sections, selected, cursor);
  const loopsToRender = shown.filter((i) => i.loop.state === 'missing' && !i.loop.queued).map((i) => i.component);
  return (
    <LibraryContext.Provider value={ctx}>
      <div className="lb-screen" data-testid="library" data-theme={v.theme.name}>
        <LibraryBrowser
          slug={slug}
          at="library"
          current={v.theme.name}
          components={v.items.length}
          themes={v.themes.map((t) => ({ name: t.name, source: t.source, default: t.default, opens: okTheme(t.name) }))}
        />
        <ShellSlot name="context">
          <ThemeSelect view={v} slug={slug} />
        </ShellSlot>
        <LibraryActions v={v} slug={slug} pump={pump} loopsToRender={loopsToRender} />
        <LibraryAlerts v={v} pump={pump} pumpError={pumpError} />
        {component ? (
          item ? (
            <WantLoop pump={pump} component={item.component} />
          ) : (
            <NoSuchComponent component={component} slug={slug} theme={v.theme.name} />
          )
        ) : (
          <LibraryGrid
            v={v}
            filter={filter}
            setFilter={setFilter}
            shown={shown}
            groups={groups}
            selected={selected}
            playing={playing}
            tabStop={tabStop}
            gridKeys={gridKeyHandler(sections, selected, select)}
            onCreate={() => openCreate()}
          />
        )}
        {/* One place for the component inspector, keyed by the component: the grid's and the page's. */}
        {focus ? (
          <Focused key={focus.component} item={focus} view={v} playing={playing.has(focus.component)} detail={component !== undefined} onCreate={openCreate} />
        ) : component === undefined ? (
          <ShellSlot name="inspector" inline="Library">
            <LibraryInspector view={v} shown={shown.length} />
          </ShellSlot>
        ) : null}
        <CreateSheet open={creating} slug={slug} theme={v.theme.name} taken={v.items.map((i) => i.component)} brief={brief} setBrief={setBrief} onClose={() => setCreating(false)} />
      </div>
    </LibraryContext.Provider>
  );
}
