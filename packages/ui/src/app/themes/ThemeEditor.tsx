/**
 * The theme editor (R-UI-07, R-UI-49 — `#/p/<slug>/themes/<theme>`): one theme's brand, colours, background, type pair,
 * motion, zoom, cursor and a component per kind (the fields:
 * ThemeFields.tsx, in the inspector) beside ONE live preview: the theme's intro, a clip with its caption, or its outro
 * (a segmented control picks the target; theme_preview in the sandboxed Player; a workspace component waits for Allow; a
 * theme's own video / image / Lottie is said, not shown). "Use in a scenario" writes the scenario's `template`
 *.
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
 * - Undo / redo restore exact earlier bytes the server served (ThemeHistory ≤ 50).
 * - Every string from the server (a font's name table, a warning, an error) is a text node through `Txt` or
 *   `visibleControls`; the frame runs workspace component code only on the player origin, in the sandbox.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThemeEditView } from '@retake/engine';
import type { ThemeListAnswer, ThemePreviewAnswer } from '../../server/theme-ops.js';
import { CallError, errorText } from '../api.js';
import type { Loaded } from '../api.js';
import { previewAllow, timelineLeave } from '../data/edit.js';
import { scenarioBlocks, scenarioEdit } from '../data/scenarios.js';
import { themeCopy, themeEdit, themePreview, themeView } from '../data/themes.js';
import { Txt } from '../bits.js';
import { useUnsavedMark } from '../drafts.js';
import { NEW_THEME_NAME_MAX } from '../id-words.js';
import { NEW_THEME_NAME_HINT, copyName, themeNameProblem } from '../words/library-words.js';
import { PreviewFrame } from '../edit/PreviewFrame.js';
import { hrefTo } from '../route.js';
import { SessionEnded } from '../session.js';
import { ShellSlot } from '../shell/slots.js';
import { ThemeFields } from './ThemeFields.js';
import type { Draft, Send } from './ThemeFields.js';
import { ThemeActions, ThemeBrowser, ThemeHead, ThemeIssues, ThemeUnavailable, editStatus } from './editor-chrome.js';
import type { Status } from './editor-chrome.js';
import { newLease, useLiveFrameState, useThemeRereads } from './editor-hooks.js';
import { FrameBar, FrameNotes, HeldComponents } from './frame-controls.js';
import { UseInScenarioView } from './use-in-scenario-view.js';
import type { UseState } from './use-in-scenario-view.js';
import { DraftThrottle, TARGET_WORDS, ThemeHistory, planUseInScenario, written } from '../words/theme-words.js';
import type { PreviewTarget, ThemeEdit } from '../words/theme-words.js';
import { previewUrls } from '../words/timeline-words.js';
import { Button, Callout, Segmented, Sheet, TextField } from '../ui-kit/index.js';
import { bestEffort } from '../best-effort.js';

/** The theme as the editor reads it: theme_view, read again after each write (sequence-guarded). */
function useThemeView(slug: string, theme: string): [Loaded<ThemeEditView>, () => Promise<ThemeEditView | null>] {
  const [v, setV] = useState<Loaded<ThemeEditView>>({ state: 'loading' });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const d = await themeView({ theme, project: slug });
      if (n === seq.current) setV({ state: 'ready', data: d });
      return d;
    } catch (e) {
      if (n === seq.current && !(e instanceof SessionEnded)) setV({ state: 'error', error: errorText(e), ...(e instanceof CallError ? { code: e.error.code } : {}) });
      return null;
    }
  }, [slug, theme]);
  useEffect(() => {
    setV({ state: 'loading' });
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);
  return [v, load];
}

/** The live frame: a lease left with the screen, theme_preview asked per version shown and per target, drafts throttled. */
function useLivePreview(slug: string, theme: string, target: PreviewTarget, shownSha: string | undefined) {
  const [lease] = useState(newLease);
  useEffect(
    () => () => {
      void bestEffort(timelineLeave({ project: slug, lease }), 'the lease expires by itself when the leave is not heard');
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
        const a = await themePreview({ project: slug, theme, target, lease, ...(d && (d.colors || d.background) ? { draft: d } : {}) });
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
  useEffect(() => {
    if (shownSha === undefined) return;
    void askPreview(null);
  }, [shownSha, askPreview]);
  return { answer, previewError, askPreview, throttle };
}

/** What the one write path reads and sets: the version shown, its history, the screen's state and the live frame. */
interface WriteCtx {
  v: ThemeEditView | null;
  /** The project whose screen it is: its own themes are found first. */
  slug: string;
  theme: string;
  load: () => Promise<ThemeEditView | null>;
  history: { current: ThemeHistory };
  busyRef: { current: boolean };
  setBusy: (b: string | null) => void;
  setStatus: (s: Status) => void;
  setDraftState: (d: Draft | null) => void;
  throttle: DraftThrottle<Draft>;
  askPreview: (d: Draft | null) => Promise<void>;
  rerender: (f: (n: number) => number) => void;
}

/** The one write path: theme_edit on the version shown (if_match its sha256), an edit, an undo or a redo; the view read again. */
function makeWrite({ v, slug, theme, load, history, busyRef, setBusy, setStatus, setDraftState, throttle, askPreview, rerender }: WriteCtx) {
  return async (edit: ThemeEdit, mode: 'edit' | 'undo' | 'redo' = 'edit'): Promise<boolean> => {
    if (!v || busyRef.current) return false;
    busyRef.current = true;
    setBusy(mode === 'undo' ? 'Undoing…' : mode === 'redo' ? 'Redoing…' : 'Saving…');
    throttle.cancel();
    const before = v.yaml !== null ? { text: v.yaml, sha256: v.sha256 } : null;
    const step = mode === 'undo' ? history.current.undoStep() : mode === 'redo' ? history.current.redoStep() : null;
    try {
      const r = await themeEdit({ theme, project: slug, if_match: step ? step.if_match : v.sha256, edit: step ? step.edit : edit });
      const nv = await load();
      if (mode === 'undo') history.current.undone();
      else if (mode === 'redo') history.current.redone();
      else if (before && nv && nv.sha256 === r.sha256 && nv.yaml !== null) history.current.push(r.label, before, { text: nv.yaml, sha256: nv.sha256 });
      else history.current.clear();
      if (nv) history.current.sync(nv.sha256);
      setStatus(editStatus(r, mode === 'undo' ? `Undone: ${step!.label}` : mode === 'redo' ? `Redone: ${step!.label}` : r.label));
      setDraftState(null);
      return true;
    } catch (e) {
      if (e instanceof SessionEnded) return false;
      setDraftState(null);
      if (e instanceof CallError && e.error.code === 'conflict') {
        const nv = await load();
        if (nv) history.current.sync(nv.sha256);
        setStatus({
          tone: 'warning',
          text: `The theme changed meanwhile (another window, Claude or a person): your change was not written. The editor now shows the new version — make it again if you still want it. (${e.error.message})`,
        });
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
}

export function ThemeEditor({ slug, theme, list }: { slug: string; theme: string; list: Loaded<ThemeListAnswer> }) {
  const [view, load] = useThemeView(slug, theme);
  const history = useRef(new ThemeHistory());
  const [, rerender] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(null);
  // A colour or background picked and not written yet is unsaved for the desktop app's quit question.
  useUnsavedMark(draft && (draft.colors || draft.background) ? { kind: 'theme_draft', project: slug } : null);
  const [target, setTarget] = useState<PreviewTarget>('intro');
  const [rippleFollows, setRippleFollows] = useState(true);
  const v = view.state === 'ready' ? view.data : null;

  useThemeRereads(slug, theme, load, { busyRef, history, rerender });
  const { answer, previewError, askPreview, throttle } = useLivePreview(slug, theme, target, v?.sha256);
  const setDraftNow = (d: Draft) => {
    setDraftState(d);
    throttle.push(d);
  };

  // ── Writes ──
  const write = makeWrite({ v, slug, theme, load, history, busyRef, setBusy, setStatus, setDraftState, throttle, askPreview, rerender });
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
  // Stable for the memoised fields (a drag renders the dragged field, not every section): they call the
  // latest closures.
  const latest = useRef({ send, setDraftNow });
  latest.current = { send, setDraftNow };
  const stableSend = useCallback<Send>((plan) => latest.current.send(plan), []);
  const setDraft = useCallback((d: Draft) => latest.current.setDraftNow(d), []);
  const reloadView = useCallback(() => void load(), [load]);

  if (view.state === 'loading' || view.state === 'error' || !v) return <ThemeUnavailable view={view} slug={slug} theme={theme} />;
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
      <ThemeActions
        slug={slug}
        busy={busy}
        editable={editable}
        canUndo={!!undo}
        canRedo={!!redo}
        noScenario={scenarios.length === 0}
        onUndo={() => void write(undo!.edit, 'undo')}
        onRedo={() => void write(redo!.edit, 'redo')}
      />
      <ThemeHead v={v} slug={slug} editable={editable} />
      {!editable && <CopyToEdit slug={slug} theme={v.name} why={v.editable === true ? '' : v.editable.why} taken={listed?.themes.map((t) => t.name) ?? []} />}
      {v.issues.length > 0 && <ThemeIssues issues={v.issues} />}
      <p className="tm-status" role="status" aria-live="polite" data-tone={status?.tone ?? 'info'} data-testid="theme-status">
        {busy ? <Txt text={busy} /> : status ? <Txt text={status.text} /> : editable ? 'Each change is written at once (Undo takes it back).' : ''}
      </p>
      <LivePreview target={target} setTarget={setTarget} answer={answer} previewError={previewError} drafting={draft !== null} onAgain={() => void askPreview(draft)} />
      <UseInScenario slug={slug} theme={v.name} scenarios={scenarios} onChanged={reloadView} />
      <ShellSlot name="inspector" inline="Fields">
        <ThemeFields v={v} slug={slug} off={off} draft={draft} paper={paper} rippleFollows={rippleFollows} setRippleFollows={setRippleFollows} listed={listed} send={stableSend} setDraft={setDraft} />
      </ShellSlot>
    </div>
  );
}

/** The live preview section: the target control, then the frame, its progress or its error. */
function LivePreview({
  target,
  setTarget,
  answer,
  previewError,
  drafting,
  onAgain,
}: {
  target: PreviewTarget;
  setTarget: (t: PreviewTarget) => void;
  answer: ThemePreviewAnswer | null;
  previewError: string | null;
  drafting: boolean;
  onAgain(): void;
}) {
  return (
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
        <LiveFrame v={answer} drafting={drafting} onAgain={onAgain} />
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
  );
}

/** "Copy to edit…": a starter or read-only theme copied to a workspace theme (theme_copy, a kit Sheet asks the name), then opened. */
export function CopyToEdit({ slug, theme, why, taken }: { slug: string; theme: string; why: string; taken: string[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(() => copyName(theme, taken));
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});
  const problem = themeNameProblem(name, taken);
  const copy = async () => {
    if (problem) return setState({ error: problem });
    setState({ busy: true });
    try {
      const c = await themeCopy({ from: theme, name, project: slug });
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
            <TextField
              label="Name of the copy"
              value={name}
              onChange={(x) => setName(x.trim())}
              unsaved={null}
              mono
              maxLength={NEW_THEME_NAME_MAX}
              hint={NEW_THEME_NAME_HINT}
              autoComplete="off"
              spellCheck={false}
              testId="theme-copy-name"
              error={problem ?? undefined}
            />
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
  const f = useLiveFrameState('frame' in v ? v.frame : undefined, urls?.plan);
  const { state, setState, setRestart, setAllowing, setAllowError } = f;
  const held = v.preview_held ?? [];
  const allow = (c: { id: string; hash: string }) => {
    setAllowing(c.id);
    setAllowError(null);
    previewAllow({ id: c.id, hash: c.hash })
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
      <section className="tm-frame" aria-label="Live preview" aria-busy={state === 'loading'} data-testid="theme-preview" data-state={urls ? state : 'none'} data-settles={f.settles}>
        {urls && state !== 'stopped' && (
          <PreviewFrame
            key={`${urls.frame}#${f.restart}`}
            url={urls.frame}
            planUrl={urls.plan}
            frameRef={f.frameRef}
            onMessage={f.onMessage}
            onHello={f.onHello}
            onStop={f.onStop}
            onConnection={f.onConnection}
          />
        )}
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
      </section>
      <FrameBar
        framed={!!urls}
        state={state}
        playing={f.playing}
        drafting={drafting}
        component={v.target.component}
        onPlay={() => f.conn.current?.send(f.playing ? { type: 'pause' } : { type: 'play' })}
        onRestart={() => (setRestart((n) => n + 1), setState('loading'))}
      />
      <FrameNotes notes={f.notes} />
      <HeldComponents held={held} heldId={f.heldId} allowing={f.allowing} allowError={f.allowError} onAllow={allow} />
    </div>
  );
}

/**
 * "Use in this scenario": the scenario's `template` set to this theme through scenario_edit `set_field`
 * on the version scenario_blocks showed; Undo restores those exact bytes. Every existing take re-plans with it at its
 * next render; the cursor style is filmed.
 */
const UseInScenario = memo(function UseInScenario({ slug, theme, scenarios, onChanged }: { slug: string; theme: string; scenarios: string[]; onChanged(): void }) {
  const [scenario, setScenario] = useState(scenarios[0] ?? '');
  const [st, setSt] = useState<UseState>({ s: 'idle' });
  useEffect(() => {
    if (!scenario && scenarios[0]) setScenario(scenarios[0]);
  }, [scenario, scenarios]);
  const fail = (e: unknown) => {
    if (!(e instanceof SessionEnded))
      setSt({ s: 'error', message: e instanceof CallError && e.error.code === 'conflict' ? 'The scenario changed meanwhile: nothing was written. Try again.' : errorText(e) });
  };
  const use = async () => {
    setSt({ s: 'busy' });
    try {
      const b = await scenarioBlocks({ project: slug, name: scenario });
      const plan = planUseInScenario(b, theme);
      if ('already' in plan) return setSt({ s: 'already', scenario });
      if ('why' in plan) return setSt({ s: 'error', message: plan.why });
      const r = await scenarioEdit({ project: slug, name: scenario, hash: b.hash, edit: plan.edit });
      setSt({ s: 'done', scenario, label: r.label, hash: r.hash, previous: { text: b.text, hash: b.hash } });
      onChanged();
    } catch (e) {
      fail(e);
    }
  };
  const undo = async (d: Extract<UseState, { s: 'done' }>) => {
    setSt({ s: 'busy' });
    try {
      await scenarioEdit({ project: slug, name: d.scenario, hash: d.hash, edit: { kind: 'restore', text: d.previous.text, text_hash: d.previous.hash } });
      setSt({ s: 'undone', scenario: d.scenario });
      onChanged();
    } catch (e) {
      fail(e);
    }
  };
  return <UseInScenarioView slug={slug} theme={theme} scenarios={scenarios} scenario={scenario} setScenario={setScenario} st={st} onUse={() => void use()} onUndo={(d) => void undo(d)} />;
});
