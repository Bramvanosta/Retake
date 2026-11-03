/**
 * The theme editor (L4.7 part D2, R-UI-07; L5.12c « Épure » 4c, R4-Theme, R-UI-49 — `#/p/<slug>/themes/<theme>`): one
 * theme's brand, colours, background, type pair, motion, zoom, cursor and a component per kind (the fields:
 * ThemeFields.tsx, in the inspector) beside ONE live preview: the theme's intro, a clip with its caption, or its outro
 * (a segmented control picks the target; theme_preview in the sandboxed Player; a workspace component waits for Allow; a
 * theme's own video / image / Lottie is said, not shown, B10). "Use in a scenario" writes the scenario's `template`
 * (critique B1).
 *
 * In the shell: the browser is the theme's sections (anchors into the inspector) and its components (each to the
 * library); the inspector holds the fields; the status bar says "Each change is saved and checked", Undo, Redo,
 * Extract from a website… (the Themes list's site panel) and Use in a scenario…
 *
 * - The one write path is `theme_edit` on the version shown (if_match its sha256): each control's change is one
 *   verified write; the view is then read again (the new sha256, the palette checks) and the frame re-plans. A 409
 *   (someone else wrote) re-reads the theme and says the change was not written. Starters and read-only themes show
 *   their values with "Copy to edit…" (a kit Sheet: theme_copy).
 * - Colours being dragged are previewed in memory (theme_preview `draft`, at most five a second: DraftThrottle) and
 *   written on release (the input's `change`); a draft not written yet is unsaved (`theme_draft`).
 * - Undo / redo restore exact earlier bytes the server served (ThemeHistory ≤ 50, critique B14).
 * - Every string from the server (a font's name table, a warning, an error) is a text node through `Txt` or
 *   `visibleControls`; the frame runs workspace component code only on the player origin, in the sandbox.
 */
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ThemeEditResult, ThemeEditView } from '@demo-studio/engine';
import type { ThemeListAnswer, ThemePreviewAnswer } from '../server/theme-ops.js';
import { CallError, call, errorText } from './api.js';
import type { Loaded } from './api.js';
import { Txt } from './bits.js';
import { useUnsavedMark } from './drafts.js';
import { useEvents } from './events.js';
import { copyName, okId, themeNameProblem } from './library-words.js';
import { PreviewFrame } from './PreviewFrame.js';
import type { PreviewConnection } from '../player/parent.js';
import type { FrameMessage } from '../player/protocol.js';
import { hrefTo } from './route.js';
import { SessionEnded } from './session.js';
import { ShellSlot } from './shell/slots.js';
import { SECTIONS, ThemeFields, showSection } from './ThemeFields.js';
import type { Draft, Send } from './ThemeFields.js';
import { DraftThrottle, EDITOR_KINDS, TARGET_WORDS, ThemeHistory, USE_IN_SCENARIO_WORDS, componentRow, kindLabel, themeEventAction, useInScenarioPlan, usedByWords, written } from './theme-words.js';
import type { PreviewTarget, ScenarioFacts, ThemeEdit } from './theme-words.js';
import { previewUrls } from './timeline-words.js';
import { Button, Callout, LinkButton, Segmented, Select, Sheet, SourceList, StatusMark, Tag, TextField } from './ui-kit/index.js';

/** A random lease id (22 base64url characters) for theme_preview / timeline_leave. */
function newLease(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface Status {
  tone: 'info' | 'warning' | 'danger';
  text: string;
}

/** The select of "Use in a scenario" (the status bar's "Use in a scenario…" brings the focus to it). */
const USE_SELECT = 'tm-use-scenario';

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

/** The browser: the theme's sections (anchors into the inspector's fields) and its components (each to the library). */
const ThemeBrowser = memo(function ThemeBrowser({ slug, v }: { slug: string; v: ThemeEditView }) {
  return (
    <ShellSlot name="browser">
      <SourceList
        label="Theme sections"
        groups={[
          { key: 'sections', heading: <Txt text={v.name} />, label: 'Sections', items: SECTIONS.map((s) => ({ key: s.key, label: s.title, current: false, onSelect: () => showSection(s.key) })) },
          {
            key: 'components',
            heading: 'Components',
            label: 'Components of this theme',
            items: EDITOR_KINDS.map((k) => {
              const picked = componentRow(v, k).picked;
              return { key: k, label: kindLabel(k), current: false, detail: <Txt className="k-mono" text={picked ?? 'none'} />, quiet: picked === null, ...(picked && okId(picked) ? { to: { name: 'library' as const, slug, theme: v.name, component: picked } } : { onSelect: () => showSection('components') }) };
            }),
          },
          {
            key: 'back',
            items: [
              { key: 'themes', to: { name: 'themes', slug }, label: 'All themes', icon: 'theme', current: false },
              { key: 'library', to: { name: 'library', slug, theme: v.name }, label: 'Components in this theme', icon: 'components', current: false },
            ],
          },
        ]}
      />
    </ShellSlot>
  );
});

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
  const setDraftNow = (d: Draft) => {
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
  const send: Send = (plan) => {
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
  // Stable for the memoised fields (review A-L4: a drag renders the dragged field, not every section): they call the
  // latest closures.
  const latest = useRef({ send, setDraftNow });
  latest.current = { send, setDraftNow };
  const stableSend = useCallback<Send>((plan) => latest.current.send(plan), []);
  const setDraft = useCallback((d: Draft) => latest.current.setDraftNow(d), []);
  const reloadView = useCallback(() => void load(), [load]);

  if (view.state === 'loading') {
    return (
      <div className="tm-screen">
        <p className="tm-quiet" role="status">
          <Txt text={`Loading theme ${theme}…`} />
        </p>
      </div>
    );
  }
  if (view.state === 'error' || !v) {
    return (
      <div className="tm-screen">
        <h1 className="tm-h1">
          <Txt text={theme} />
        </h1>
        <Callout state={view.state === 'error' && view.code === 'not_found' ? 'warn' : 'fail'} role="alert" title="This theme cannot be opened">
          <p className="tm-pre">
            <Txt text={view.state === 'error' ? view.error : ''} />
          </p>
          <LinkButton size="sm" to={{ name: 'themes', slug }}>
            Back to the themes
          </LinkButton>
        </Callout>
      </div>
    );
  }
  const editable = v.editable === true;
  const off = !editable || busy !== null;
  const listed = list.state === 'ready' ? list.data : null;
  const paper = typeof written(v, 'colors.paper') === 'string' ? (written(v, 'colors.paper') as string) : '#ffffff';
  const undo = history.current.undoStep();
  const redo = history.current.redoStep();
  const scenarios = listed?.scenarios ?? [];

  return (
    <div className="tm-screen tm-editor" data-testid="theme-editor" data-theme={v.name} data-sha={v.sha256} data-editable={editable ? 'yes' : 'no'}>
      <ThemeBrowser slug={slug} v={v} />
      <ShellSlot name="actions">
        <span className="sh-scenario" data-testid="theme-state">
          {busy ? <StatusMark state="running" word={`Busy: ${busy}`} /> : editable ? <StatusMark state="idle" word="Ready · each change is saved and checked" /> : <StatusMark state="idle" word="Read-only: copy it to edit it" />}
        </span>
        <Button size="sm" variant="ghost" icon="undo" data-testid="theme-undo" disabled={!editable || busy !== null || !undo} onClick={() => void write(undo!.edit, 'undo')}>
          Undo
        </Button>
        <Button size="sm" variant="ghost" icon="redo" data-testid="theme-redo" disabled={!editable || busy !== null || !redo} onClick={() => void write(redo!.edit, 'redo')}>
          Redo
        </Button>
        <LinkButton size="sm" variant="ghost" to={{ name: 'themes', slug }}>
          Extract from a website…
        </LinkButton>
        <Button
          size="sm"
          variant="ghost"
          disabled={scenarios.length === 0}
          onClick={() => {
            const el = document.getElementById(USE_SELECT);
            el?.scrollIntoView({ block: 'nearest' });
            el?.focus();
          }}
        >
          Use in a scenario…
        </Button>
      </ShellSlot>
      <header className="tm-head">
        <h1 className="tm-h1">
          <Txt text={v.name} />
        </h1>
        <span className="tm-tags">
          <Tag>{editable ? 'Editable · in this workspace' : 'Read-only'}</Tag>
          <Tag>{v.source === 'starter' ? 'Starter' : 'Workspace'}</Tag>
          <span className="tm-quiet" data-testid="theme-used-by">
            <Txt text={usedByWords(v.used_by, slug)} />
          </span>
        </span>
      </header>
      {!editable && <CopyToEdit slug={slug} theme={v.name} why={v.editable === true ? '' : v.editable.why} taken={listed?.themes.map((t) => t.name) ?? []} />}
      {v.issues.length > 0 && (
        <Callout state="fail" role="note" title="This theme has problems">
          <ul className="tm-issues">
            {v.issues.slice(0, 6).map((x, i) => (
              <li key={i}>
                <Txt text={x} />
              </li>
            ))}
          </ul>
        </Callout>
      )}
      <p className="tm-status" role="status" aria-live="polite" data-tone={status?.tone ?? 'info'} data-testid="theme-status">
        {busy ? <Txt text={busy} /> : status ? <Txt text={status.text} /> : editable ? 'Each change is written at once (Undo takes it back).' : ''}
      </p>
      <section className="tm-live" aria-labelledby="tm-live-h">
        <div className="tm-live-head">
          <h2 id="tm-live-h" className="tm-h2">
            Live preview
          </h2>
          <span className="tm-quiet">No render: the preview follows each change</span>
          <span className="tm-live-target" data-testid="chips-target">
            <Segmented<PreviewTarget> label="Show" size="sm" value={target} onChange={setTarget} options={(['intro', 'clip', 'outro'] as const).map((t) => ({ value: t, label: TARGET_WORDS[t] }))} />
          </span>
        </div>
        {answer ? (
          <LiveFrame v={answer} drafting={draft !== null} onAgain={() => void askPreview(draft)} />
        ) : previewError ? null : (
          <p className="tm-quiet" role="status">
            Loading the preview…
          </p>
        )}
        {previewError && (
          <p className="tm-failure" role="status" data-testid="theme-preview-error">
            <Txt text={previewError} />
          </p>
        )}
      </section>
      <UseInScenario slug={slug} theme={v.name} scenarios={scenarios} onChanged={reloadView} />
      <ShellSlot name="inspector" inline="Fields">
        <ThemeFields v={v} slug={slug} off={off} draft={draft} paper={paper} rippleFollows={rippleFollows} setRippleFollows={setRippleFollows} listed={listed} send={stableSend} setDraft={setDraft} />
      </ShellSlot>
    </div>
  );
}

/** "Copy to edit…": a starter or read-only theme copied to a workspace theme (theme_copy, a kit Sheet asks the name), then opened. */
function CopyToEdit({ slug, theme, why, taken }: { slug: string; theme: string; why: string; taken: string[] }) {
  const [open, setOpen] = useState(false);
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
    <Callout state="idle" role="note" title="Read-only here">
      <p className="tm-line" data-testid="theme-readonly-why">
        <Txt text={why} />
      </p>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)} data-testid="theme-copy-open">
        Copy to edit…
      </Button>
      <Sheet
        open={open}
        testId="theme-copy-sheet"
        title={`Copy ${theme} to edit it`}
        actions={[
          { id: 'copy', label: state.busy ? 'Copying…' : 'Copy to edit', variant: 'primary', isDefault: true, disabled: state.busy === true || problem !== null, testId: 'theme-copy' },
          { id: 'cancel', label: 'Cancel', isCancel: true },
        ]}
        onAction={(id) => {
          if (id === 'copy') void copy();
          else {
            setOpen(false);
            setState({});
          }
        }}
        content={
          <>
            <TextField label="Name of the copy" value={name} onChange={(x) => setName(x.trim())} unsaved={null} mono maxLength={100} autoComplete="off" spellCheck={false} testId="theme-copy-name" error={problem ?? undefined} />
            {state.error && (
              <p className="tm-failure" role="status">
                <Txt text={state.error} />
              </p>
            )}
          </>
        }
      >
        The copy is a theme of this workspace: the Studio edits it; this one stays as it is.
      </Sheet>
    </Callout>
  );
}

/**
 * The frame of a theme_preview answer: the sandboxed Player loads the preview at its still's moment and settles
 * there; Play loops it (a toggle with one name). A workspace component it uses waits for Allow (preview_allow).
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
  const heldId = useId();
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
    <div className="tm-frame-wrap">
      <div className="tm-frame" role="region" aria-label="Live preview" aria-busy={state === 'loading'} data-testid="theme-preview" data-state={urls ? state : 'none'} data-settles={settles}>
        {urls && state !== 'stopped' && <PreviewFrame key={`${urls.frame}#${restart}`} url={urls.frame} planUrl={urls.plan} frameRef={frameRef} onMessage={onMessage} onHello={onHello} onStop={onStop} onConnection={onConnection} />}
        {urls && state === 'loading' && (
          <p className="tm-note" role="status">
            Loading the preview…
          </p>
        )}
        {'not_previewed' in v && (
          <p className="tm-note tm-note-message" role="status" data-testid="theme-not-previewed">
            <Txt text={`Not previewed: ${v.not_previewed}.`} />
          </p>
        )}
        {'preview_error' in v && (
          <p className="tm-note tm-note-message" role="status" data-testid="theme-preview-error">
            {'The preview cannot show this: '}
            <Txt text={v.preview_error} />
          </p>
        )}
      </div>
      <div className="tm-frame-bar">
        <Button size="sm" icon="play" aria-pressed={playing} disabled={!urls || state === 'loading'} data-testid="theme-play" onClick={() => conn.current?.send(playing ? { type: 'pause' } : { type: 'play' })}>
          Play
        </Button>
        {state === 'stopped' && (
          <Button size="sm" onClick={() => (setRestart((n) => n + 1), setState('loading'))}>
            Restart the preview
          </Button>
        )}
        <span className="tm-quiet">{drafting ? 'Showing the colour you are changing (not written yet).' : v.target.component ? <Txt className="k-mono" text={v.target.component} /> : null}</span>
      </div>
      {notes.length > 0 && (
        <ul className="tm-notes">
          {notes.map((n, i) => (
            <li key={i}>
              <Txt text={n} />
            </li>
          ))}
        </ul>
      )}
      {held.length > 0 && (
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
                  <Button size="sm" data-testid="allow-component" disabled={allowing !== null} onClick={() => allow(c)}>
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
const UseInScenario = memo(function UseInScenario({ slug, theme, scenarios, onChanged }: { slug: string; theme: string; scenarios: string[]; onChanged(): void }) {
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
    <section className="tm-use" aria-labelledby="tm-use-h" data-testid="use-in-scenario">
      <h2 id="tm-use-h" className="tm-h2">
        Use in a scenario
      </h2>
      {scenarios.length === 0 ? (
        <p className="tm-quiet">This project has no scenario yet.</p>
      ) : (
        <>
          <div className="tm-use-line">
            <Select label="Scenario" layout="inline" id={USE_SELECT} value={scenario} onChange={setScenario} testId="use-scenario" options={scenarios.map((s) => ({ value: s, label: s }))} />
            <Button disabled={st.s === 'busy' || !scenario} onClick={() => void use()} data-testid="use-in-scenario-go">
              Use in this scenario
            </Button>
          </div>
          <p className="tm-quiet">
            <Txt text={`${USE_IN_SCENARIO_WORDS} The project's own theme stays as project.yaml names it.`} />
          </p>
        </>
      )}
      <div className="tm-line" role="status" aria-live="polite" data-testid="use-in-scenario-state">
        {st.s === 'busy' && 'Writing the scenario…'}
        {st.s === 'already' && (
          <>
            <Txt text={st.scenario} />
            {' already uses '}
            <Txt text={theme} />
            {'.'}
          </>
        )}
        {st.s === 'undone' && (
          <>
            {'Undone: '}
            <Txt text={st.scenario} />
            {' is back to the version before.'}
          </>
        )}
        {st.s === 'error' && (
          <span className="tm-failure">
            <Txt text={st.message} />
          </span>
        )}
        {st.s === 'done' && (
          <>
            <Txt text={st.label} />
            {'. '}
            <LinkButton size="sm" variant="ghost" to={{ name: 'timeline', slug, scenario: st.scenario }} testId="use-in-scenario-timeline">
              Open its timeline
            </LinkButton>{' '}
            <Button size="sm" onClick={() => void undo(st)} data-testid="use-in-scenario-undo">
              Undo
            </Button>
          </>
        )}
      </div>
    </section>
  );
});
