/**
 * The Record screen (L4.8, R-UI-20 / 21 / 22; L5.11b: « Épure » 3b, R4-Record, R-UI-44 — on the kit, in the shell): the
 * control panel of the REAL browser window the worker opens on this Mac, full size — the person clicks through the
 * product there; nothing typed or clicked here reaches the window (no input is forwarded: BL-25). Two routes:
 *
 * - `#/p/<slug>/record` — the start form in the centre (`record_options`): location, page, persona (Selects), path and
 *   name (TextFields: no unsaved mark — nobody's work), the persona's stored session with its Sign in, the window note
 *   (a full-size window: the desktop layout is what the video films), the location's warnings, the recording already
 *   open in the workspace (one window at a time). Start (`record_start`: page and path only, the check replay always
 *   on) opens the recording's route, its title focused.
 * - `#/p/<slug>/record/<rec_id>` — one recording (`record_view`, read every 700 ms while it is live and the tab is
 *   visible, every 3 s once it is over, and at once on a `workspace {records}` or `jobs` event; `since` makes an
 *   unchanged read cheap). Centre: "Recording <name>", the state in a sentence, the time left, the window callout, the
 *   draft as step rows (page text through `Txt` only). A row is a pressed button: pressing it puts the draft cursor right
 *   after it (keyed by the row's identity, never its index — it stays on its row while the draft regenerates and moves
 *   onto a hold or a wait it adds), shows the row's verified target alternatives as a radio group (`record_annotate
 *   choose`) and the Insert toolbar "Insert after step n" (Hold 2 s, Wait for…, Caption…, Mark, Zoom… up to the theme's
 *   max_zoom: `record_annotate insert`; at the end, a hold or a wait goes before the next action and the rest waits for
 *   it — critique B3 of L4.8); pressing it again (or Back to the end) moves the cursor back to the end. Inspector:
 *   Started with (its facts, the name Save uses), the selected step (its facts, Add after this step), Stop recording /
 *   Save as new scenario (with why it waits) / Discard (the kit's sheet: "Keep it" is the default, Return never
 *   discards), then the check (a replay of the recorded draft without the picks and inserts, its failing step shown on
 *   its row), the issues, the secret placeholders as `{{vars.…}}` names only (never a value), the writes with the reset
 *   advice. Browser: Shoot's, with the Recordings group (ShootBrowser). Recordings Claude or a terminal started are
 *   shown read-only (Q5).
 * - The status bar while a recording is live (queued → check): this screen's — "Recording · browser window open",
 *   "n actions · n inserts · draft updated …" — and the Scenario menu's commands at the recording's priority
 *   (command-bus.ts PRIORITY.recording, from the first paint of the route: a reload included): ⌘. stops THIS recording
 *   (never a run of the scenario in context — critique H1 / M7 of L5.11), Rehearse / Capture / Render say why they wait
 *   and send nothing (critique L2). The one Stop visible is the inspector's (shown in place when the inspector is hidden).
 *
 * Accessibility: every control is a kit button, field or radio group; the insert forms are disclosures (Enter adds,
 * Escape closes and gives focus back); the cursor is a block with words, never only a colour; the steps are a list, not
 * a live region — state changes and each change made ("Hold added after step 2 of products") are said in the status
 * bar's polite line (shell/say.ts); severities are words with a glyph; the focus is never dropped (a control that goes or
 * turns disabled under it hands the focus to its replacement, else to the title).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RecordListItem } from '@retake/engine';
import { useRecordOptions } from '../data/record.js';
import { Txt, plural } from '../bits.js';
import { say } from '../shell/say.js';
import { ShellSlot } from '../shell/slots.js';
import { RECORD_MARK } from '../shoot/ShootBrowser.js';
import { Callout, StatusMark, studioShell } from '../ui-kit/index.js';
import { LIVE_STATES, STATE_WORDS, statusLine } from '../words/record-words.js';
import { RecordBrowser } from './RecordBrowser.js';
import { RecordingBody } from './RecordingBody.js';
import { StartScreen } from './StartScreen.js';
import { draftRows } from './draft.js';
import type { Cursor, RecordingUi } from './draft.js';
import { useRecordView, useFocusKeeper } from './record-view.js';
import { focusOnArrival } from './started.js';
import { useRecordingActions, useRecordingCommands } from './recording-actions.js';

/** "just now", "12 s ago", "3 min ago". */
function agoWords(since: number, now: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  return `${Math.floor(s / 60)} min ago`;
}

function RecordingScreen({ slug, rec }: { slug: string; rec: string }) {
  const [v, error, reload, accept, resync, latest] = useRecordView(slug, rec);
  const [cursor, setCursor] = useState<Cursor>({ at: 'end' });
  const [note, setNote] = useState<RecordingUi['note']>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [changedAt, setChangedAt] = useState(() => Date.now());
  const title = useRef<HTMLHeadingElement>(null);
  const said = useRef<string | null>(null);
  const inApp = useMemo(() => studioShell() !== null, []);
  const state = v?.state;
  const live = v ? LIVE_STATES.has(v.state) : error === null;
  useFocusKeeper(title);
  // A recording opens at the top of the centre pane (the start form shares the screen's key: no scroll back by the shell).
  useEffect(() => document.getElementById('main')?.scrollTo?.({ top: 0, left: 0, behavior: 'auto' }), []);
  // The clock ticks while the recording goes (the time left, "draft updated …").
  useEffect(() => {
    if (!state || !LIVE_STATES.has(state)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state]);
  // When the draft last changed (the status bar's "draft updated …").
  const version = v?.version;
  useEffect(() => {
    if (version) setChangedAt(Date.now());
  }, [version]);
  // A recording just started here: its title takes the focus (the start form and its button are gone).
  useEffect(() => {
    if (v && focusOnArrival.delete(rec)) title.current?.focus({ preventScroll: true });
  }, [v, rec]);
  // The polite line: a state change (or the save) — not the state the screen opened on.
  useEffect(() => {
    if (!v) return;
    const line = statusLine(v.state, v.saved !== null);
    if (said.current !== null && line !== said.current) say(line);
    said.current = line;
  }, [v]);
  // A cursor on a row that is gone (an insert removed, a click folded into its typing): back to the end.
  const rows = useMemo(() => new Set(v?.untrusted ? draftRows(v.untrusted).flatMap((s) => s.rows.map((r) => r.id)) : []), [v]);
  useEffect(() => {
    if (cursor.at === 'after' && v?.untrusted && !rows.has(cursor.row)) setCursor({ at: 'end' });
  }, [cursor, rows, v]);
  // A discard that is over: the screen says "discarded" — the note about it goes (review B-M5 of L4.8).
  useEffect(() => {
    if (discarding && state && !LIVE_STATES.has(state)) {
      setDiscarding(false);
      setNote(null);
    }
  }, [discarding, state]);
  // Shoot's browser: the project's recordings, read again when this one changes state or is saved.
  const [opts, reloadOpts] = useRecordOptions({ project: slug }, slug);
  const savedName = v?.saved?.name;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (state) reloadOpts();
  }, [state, savedName, reloadOpts]);
  const { act, busy } = useRecordingActions({ slug, rec, cursor, setCursor, reload, accept, resync, latest, setNote, setTaken, setDiscarding, setConfirming });
  useRecordingCommands(v, live, act, setConfirming);
  const statusWords = !v ? 'Recording · reading it' : v.state === 'recording' ? 'Recording · browser window open' : `Recording · ${STATE_WORDS[v.state]?.[0] ?? v.state}`;
  const u = v?.untrusted;
  const counts = v ? `${plural(v.counts.actions, 'action')}${u ? ` · ${plural(u.inserts.length, 'insert')} · draft updated ${agoWords(changedAt, Math.max(now, changedAt))}` : ''}` : '';
  return (
    <div className="sc-screen rc-screen">
      <RecordBrowser slug={slug} recordings={{ items: opts.state === 'ready' ? opts.data.recent : null, current: rec, live: v ? ({ rec_id: rec, state: v.state, actions: v.counts.actions } as Pick<RecordListItem, 'rec_id' | 'state' | 'actions'>) : null }} />
      {live && (
        <ShellSlot name="actions">
          <span className="sh-scenario" data-testid="status-recording" data-state={v?.state ?? 'loading'}>
            <StatusMark state={v ? (RECORD_MARK[v.state] ?? 'recording') : 'running'} word={<Txt text={statusWords} />} />
            {counts && (
              <span className="sh-seg" data-drop="last" data-testid="status-recording-counts">
                <Txt text={` · ${counts}`} />
              </span>
            )}
          </span>
        </ShellSlot>
      )}
      {!v && !error && (
        <header className="rc-head">
          <div className="rc-head-text">
            <h1 className="sc-h1" tabIndex={-1} ref={title} data-testid="record-title">
              Recording
            </h1>
            <p className="sc-quiet">Reading the recording…</p>
          </div>
        </header>
      )}
      {error && !v && (
        <>
          <header className="rc-head">
            <div className="rc-head-text">
              <h1 className="sc-h1" tabIndex={-1} ref={title}>
                Recording
              </h1>
            </div>
          </header>
          <Callout state="fail" role="alert" title="Failed: this recording cannot be read">
            <p className="rc-pre">
              <Txt text={error} />
            </p>
          </Callout>
        </>
      )}
      {v && <RecordingBody slug={slug} v={v} cursor={cursor} setCursor={setCursor} ui={{ busy, note, taken, discarding: discarding && v.state !== 'discarded', confirming, now, inApp }} act={act} titleRef={title} />}
    </div>
  );
}

export function RecordScreen({ slug, rec }: { slug: string; rec?: string }) {
  return rec ? <RecordingScreen key={rec} slug={slug} rec={rec} /> : <StartScreen slug={slug} />;
}
