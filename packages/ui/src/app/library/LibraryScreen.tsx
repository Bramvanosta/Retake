/**
 * The component library (L4.7 part D1, R-UI-06 / R-UI-06b; L5.12c « Épure » 4c, R4-Library, R-UI-49 —
 * `#/p/<slug>/library[/<theme>[/<ns>/<name>]]`): every usable component of the workspace by kind, each card the
 * component's poster in the selected theme (the project's by default), its source in words ("Built-in" / "Workspace"),
 * "Theme default" for the theme's picks, and Play — the component's looping GIF in place of the poster (loops never
 * start by themselves).
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
 * L5.12c fixes: the component inspector is rendered at ONE place of the tree whether the grid or a component's page is
 * shown, keyed by the component (review B-H1: "Set as default" on a starter from the grid moves to the copy's page and
 * keeps its result, Undo and "Open the copy"); the card grid is one tab stop (review A-M3) — the arrows move the selection
 * (← → one card, ↑ ↓ a row of the section, across sections), Home / End, Escape clears it, Enter on the selected card
 * takes the focus to its inspector (in place when the inspector is hidden).
 *
 * Safety: every manifest word (a workspace component's name, description, slot / param words, README) is agent-writable
 * text shown only through `Txt`, never in an attribute; pictures reach the one `<img>` only as checked data addresses; a
 * workspace component's code never runs here (its posters and loops are pixels from the worker's guarded render
 * browser). What the screen asks for and when: library-load.ts (cards on screen only, chunks of 12, a 2 s debounce,
 * Retry; nothing while the tab is hidden).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import type { LibraryItem, LibraryViewAnswer } from '../../server/library-ops.js';
import { errorText } from '../api.js';
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
import {
  KIND_ORDER,
  NO_FILTER,
  SOURCE_WORDS,
  alsoServing,
  alsoServingWords,
  filterCounts,
  filterItems,
  groupByKind,
  isKind,
  kindHeading,
  libraryEventAction,
  okTheme,
} from '../words/library-words.js';
import type { LibraryFilter, SourceFilter } from '../words/library-words.js';
import { hrefTo } from '../route.js';
import { SessionEnded } from '../session.js';
import { ShellSlot } from '../shell/slots.js';
import { Button, Callout, ChoiceChips, Disclosure, LinkButton, Segmented, Select, StatusMark, TextField, gridColumns } from '../ui-kit/index.js';

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
        const io = get(main && main.contains(el) ? main : null);
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

function ThemeSelect({ view, slug }: { view: LibraryViewAnswer; slug: string }) {
  return (
    <Select
      label="Theme"
      layout="inline"
      value={view.theme.name}
      testId="lib-theme"
      onChange={(t) => (location.hash = hrefTo({ name: 'library', slug, theme: t }))}
      options={view.themes.map((t) => ({
        value: t.name,
        label: `${t.name}${t.default ? " — the project's theme" : ''}${t.source === 'starter' ? ' (starter)' : t.source === 'project' ? ' (project folder)' : ''}`,
      }))}
    />
  );
}

function Notices({ notices }: { notices: LibraryViewAnswer['notices'] }) {
  if (!notices.length) return null;
  const errors = notices.filter((n) => n.severity === 'error').length;
  return (
    <Disclosure testId="lib-notices" summary={`${plural(notices.length, 'registry notice')}${errors ? ` — ${plural(errors, 'component')} cannot be loaded` : ''}`}>
      <ul className="lb-notices">
        {notices.map((n, i) => (
          <li key={i}>
            <StatusMark state={n.severity === 'error' ? 'fail' : 'warn'} word={n.severity === 'error' ? 'Not loadable' : 'Warning'} /> {n.id && <Txt className="k-mono" text={n.id} />}{' '}
            <Txt text={n.untrusted.message} />
            {n.issues > 0 && <Txt className="lb-quiet" text={` (${plural(n.issues, 'issue')})`} />}
            {n.command && (
              <>
                {' '}
                <code className="k-mono lb-code">
                  <Txt text={n.command} />
                </code>
              </>
            )}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

function Filters({ items, filter, set }: { items: LibraryItem[]; filter: LibraryFilter; set: (f: LibraryFilter) => void }) {
  // A chip counts what choosing it would show under the other filters (a component under every kind it serves).
  const { all, kinds: counts } = filterCounts(items, filter);
  const kinds = [...new Set([...KIND_ORDER.filter((k) => counts[k]), ...Object.keys(counts).filter((k) => !isKind(k)), ...(filter.kind !== 'all' ? [filter.kind] : [])])];
  const kindId = useId();
  return (
    <div className="lb-filters" data-testid="lib-filters">
      <div className="lb-filter-line">
        <Segmented<SourceFilter>
          label="Source"
          size="sm"
          value={filter.source}
          onChange={(s) => set({ ...filter, source: s })}
          options={(['all', 'builtin', 'workspace'] as const).map((s) => ({ value: s, label: s === 'all' ? 'All' : SOURCE_WORDS[s].badge }))}
        />
        <div className="lb-search">
          <TextField
            label="Search components"
            labelHidden
            type="search"
            value={filter.text}
            onChange={(t) => set({ ...filter, text: t })}
            unsaved={null}
            placeholder="Name, id or description"
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            testId="lib-find"
          />
        </div>
      </div>
      <div className="lb-kinds">
        <span id={kindId} className="lb-label">
          Kind
        </span>
        <ChoiceChips
          labelledBy={kindId}
          chips={['all', ...kinds].map((k) => ({ key: k, value: k, checked: filter.kind === k, label: k === 'all' ? `All (${all})` : `${kindHeading(k)} (${counts[k] ?? 0})` }))}
          onPick={(k) => set({ ...filter, kind: k })}
        />
      </div>
    </div>
  );
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

/**
 * The grid's keys (one tab stop, review A-M3): the next card in a direction among the sections' cards, by component.
 * ← → one card (across sections), ↑ ↓ a row of the section (the columns the browser laid out; past its first or last
 * row, the same column of the section before or after), Home / End the first and the last.
 */
export function nextCard(sections: string[][], at: string, key: string, columns: number): string | null {
  const s = sections.findIndex((x) => x.includes(at));
  if (s < 0) return null;
  const flat = sections.flat();
  const i = flat.indexOf(at);
  const k = sections[s].indexOf(at);
  const len = sections[s].length;
  const cols = Math.max(1, columns);
  if (key === 'ArrowRight') return flat[Math.min(flat.length - 1, i + 1)];
  if (key === 'ArrowLeft') return flat[Math.max(0, i - 1)];
  if (key === 'Home') return flat[0];
  if (key === 'End') return flat[flat.length - 1];
  if (key === 'ArrowDown') {
    if (k + cols < len) return sections[s][k + cols];
    if (Math.floor(k / cols) < Math.floor((len - 1) / cols)) return sections[s][len - 1];
    const next = sections[s + 1];
    return next ? next[Math.min(k % cols, next.length - 1)] : at;
  }
  if (key === 'ArrowUp') {
    if (k - cols >= 0) return sections[s][k - cols];
    const prev = sections[s - 1];
    if (!prev) return at;
    const lastRow = Math.floor((prev.length - 1) / cols) * cols;
    return prev[Math.min(lastRow + (k % cols), prev.length - 1)];
  }
  return null;
}

/** Opening a component's page asks for its loop (rendered, not played: loops never start by themselves). */
function WantLoop({ pump, component }: { pump: RenderPump; component: string }) {
  useEffect(() => pump.wantLoops([component]), [pump, component]);
  return null;
}

export function LibraryScreen({ slug, theme, component }: { slug: string; theme?: string; component?: string }) {
  const args = useMemo(() => ({ project: slug, ...(theme ? { theme } : {}) }), [slug, theme]);
  const [view, reload] = useLibraryView(args, `${slug}/${theme ?? ''}`);
  const [filter, setFilter] = useState<LibraryFilter>(NO_FILTER);
  const [playing, setPlayingSet] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  // The grid's tab stop when nothing is selected: the card picked last (Escape keeps it), else the first.
  const [cursor, setCursor] = useState<string | null>(null);
  const select = useCallback((c: string | null) => {
    setSelected(c);
    if (c !== null) setCursor(c);
  }, []);
  const [creating, setCreating] = useState(false);
  const [brief, setBrief] = useState<Brief>(NO_BRIEF);
  // L5.2b (review B L7): the person's words, kept in this tab only, are unsaved text the desktop app's quit question
  // names — held here (L5.12c): closing the sheet keeps them.
  useUnsavedMark(brief.words.trim() ? { kind: 'component_brief', project: slug } : null);
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

  if (!v) {
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

  const item = component ? v.items.find((i) => i.component === component) : undefined;
  const focus = component ? item : selected ? v.items.find((i) => i.component === selected) : undefined;
  const sections = groups.map((g) => g.items.map((i) => i.component));
  const isShown = (c: string | null) => c !== null && sections.some((x) => x.includes(c));
  const tabStop = isShown(selected) ? selected : isShown(cursor) ? cursor : (sections[0]?.[0] ?? null);
  const gridKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.lb-card > .k-card');
    const card = btn?.closest<HTMLElement>('[data-testid="lib-card"]');
    const at = card?.dataset.component;
    if (!btn || !card || !at) return;
    if (e.key === 'Enter') {
      if (at !== selected) return;
      // Enter on the selected card: its inspector (the pane, or in place when the person hid it).
      e.preventDefault();
      const target = document.querySelector<HTMLElement>('[data-lib-focus]');
      target?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
      target?.focus();
      return;
    }
    if (e.key === 'Escape') {
      if (selected === null) return;
      e.preventDefault();
      select(null);
      return;
    }
    const next = nextCard(sections, at, e.key, e.key === 'ArrowDown' || e.key === 'ArrowUp' ? gridColumns(card.parentElement) : 1);
    if (next === null) return;
    e.preventDefault();
    if (next !== at || selected !== at) select(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-testid="lib-card"][data-component="${CSS.escape(next)}"] > .k-card`)?.focus();
  };
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
        {component ? (
          item ? (
            <WantLoop pump={pump} component={item.component} />
          ) : (
            <Callout state="warn" role="alert" title="No such component in the library">
              <Txt className="k-mono" text={component} />
              {' is not a usable component of this workspace (the registry notices say why when it does not load). '}
              <LinkButton size="sm" variant="ghost" to={{ name: 'library', slug, theme: v.theme.name }}>
                Back to the components
              </LinkButton>
            </Callout>
          )
        ) : (
          <>
            <header className="lb-head">
              <h1 className="lb-h1">Components</h1>
              <Txt className="lb-count" text={`${v.items.length} in ${v.theme.name}${v.theme.project_default ? ", the project's theme" : ''}`} />
              <span className="lb-head-end">
                <Button size="sm" variant="primary" onClick={() => openCreate()} data-testid="lib-create-open">
                  Create with Claude…
                </Button>
              </span>
            </header>
            <Filters items={v.items} filter={filter} set={setFilter} />
            <Notices notices={v.notices} />
            {groups.length === 0 && <p className="lb-quiet">No component matches.</p>}
            {/* The grid: one tab stop; its keys move the selection (gridKeys). */}
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
        )}
        {/* One place for the component inspector, keyed by the component: the grid's and the page's (review B-H1). */}
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
