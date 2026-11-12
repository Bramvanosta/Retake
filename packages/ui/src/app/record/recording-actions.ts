/** What a recording's screen sends: its changes, one in flight at a time, and the Scenario menu's commands while it goes. */
import { useRef, useState } from 'react';
import type { DraftIssue } from '@retake/core';
import type { RecordViewAnswer } from '../../server/record-ops.js';
import { CallError, errorText } from '../api.js';
import { recordAnnotate, recordDiscard, recordSave, recordStop } from '../data/record.js';
import { hrefTo } from '../route.js';
import { PRIORITY, useScenarioGroup, useShellCommand } from '../shell/command-bus.js';
import { say } from '../shell/say.js';
import { STATE_WORDS, annotateErrorWords, annotatedWords } from '../record-words.js';
import { cursorRow } from './draft.js';
import type { Cursor, RecordingActions, RecordingUi } from './draft.js';
import { startedJobs } from './started.js';

/** What the changes are sent with: the recording, the cursor, its view's hooks (useRecordView) and the screen's setters. */
export interface RecordingSend {
  slug: string;
  rec: string;
  cursor: Cursor;
  setCursor: (c: Cursor) => void;
  reload: () => void;
  accept: (v: RecordViewAnswer, fresh?: boolean) => void;
  resync: () => void;
  latest: () => RecordViewAnswer | null;
  setNote: (note: RecordingUi['note']) => void;
  setTaken: (name: string | null) => void;
  setDiscarding: (on: boolean) => void;
  setConfirming: (on: boolean) => void;
}

/** The recording's changes (annotate, stop, discard, save) and whether one is being written. */
export function useRecordingActions({ slug, rec, cursor, setCursor, reload, accept, resync, latest, setNote, setTaken, setDiscarding, setConfirming }: RecordingSend): { act: RecordingActions; busy: boolean } {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const job = () => {
    const j = startedJobs.get(rec) ?? latest()?.job?.id;
    return j ? { job: j } : {};
  };
  /**
   * One change in flight at a time (L5.11b fixes, review A-M1 / A-L6). Asked while one is being written: a pick waits
   * for it (the newest pick of the same step replaces an older one waiting), Stop and Discard wait for it (said, sent
   * right after); an insert, a Remove or Save is refused and said (a second press of Hold is not a second hold). A change
   * that waited reads the newest view (its revision) when it is sent.
   */
  const queue = useRef<Array<{ kind: string; f: () => Promise<void> }>>([]);
  const exec = async (j: { kind: string; f: () => Promise<void> }) => {
    busyRef.current = true;
    setBusy(true);
    setNote(null);
    try {
      await j.f();
    } finally {
      const next = queue.current.shift();
      if (next) void exec(next);
      else {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const run = (kind: string, f: () => Promise<void>) => {
    if (!busyRef.current) return void exec({ kind, f });
    if (!kind.startsWith('choose') && kind !== 'stop' && kind !== 'discard') return say('A change is being written: try again in a moment');
    queue.current = [...queue.current.filter((j) => j.kind !== kind), { kind, f }];
    if (kind === 'stop') say('Stopping once the change being written is saved');
    else if (kind === 'discard') say('Discarding once the change being written is saved');
  };
  const act: RecordingActions = {
    annotate: (change) =>
      run(change.op === 'choose' ? `choose:${change.seq}` : 'change', async () => {
        const cur = latest();
        if (!cur) return;
        try {
          const where = cursorRow(cur.untrusted, cursor);
          const r = await recordAnnotate({ project: slug, rec_id: rec, rev: cur.rev, change });
          accept(r.view, true);
          say(annotatedWords(change, change.op === 'insert' ? (where?.label ?? null) : null));
          // A hold or a wait added after a row: the cursor moves onto it (the next one goes right after it).
          if (change.op === 'insert' && cursor.at === 'after' && r.insert_id && (change.insert.kind === 'hold' || change.insert.kind === 'wait_for')) setCursor({ at: 'after', row: `i:${r.insert_id}` });
        } catch (e) {
          if (e instanceof CallError) setNote({ tone: 'warning', text: annotateErrorWords(e.status, e.error.code, e.error.message) });
          else setNote({ tone: 'danger', text: errorText(e) });
          // A stale revision: the server's view wins, whatever its revision.
          if (e instanceof CallError && e.status === 409) resync();
          else reload();
        }
      }),
    stop: () =>
      run('stop', async () => {
        try {
          const r = await recordStop({ project: slug, rec_id: rec, ...job() });
          accept(r.view, true);
          reload();
        } catch (e) {
          setNote({ tone: 'danger', text: errorText(e) });
        }
      }),
    discard: () =>
      run('discard', async () => {
        try {
          const r = await recordDiscard({ project: slug, rec_id: rec, ...job() });
          if (r.state === 'discarding') {
            setDiscarding(true);
            setNote({ tone: 'info', text: 'Being discarded: the job is cancelled, and the recording is removed once it is over.' });
          }
          reload();
        } catch (e) {
          setNote({ tone: 'danger', text: errorText(e) });
        }
      }),
    save: (name) =>
      run('save', async () => {
        const cur = latest();
        if (!cur) return;
        try {
          const r = await recordSave({ project: slug, rec_id: rec, name, rev: cur.rev, draft: cur.draft_sha256 ?? '' });
          location.hash = hrefTo({ name: 'scenario', slug, scenario: r.name, tab: 'blocks' });
        } catch (e) {
          if (e instanceof CallError && e.status === 409 && /choose another name/.test(`${e.error.message} ${e.error.fix ?? ''}`)) {
            setTaken(name);
            return;
          }
          const issues = e instanceof CallError && Array.isArray(e.error.details?.issues) ? (e.error.details.issues as DraftIssue[]) : undefined;
          setNote({ tone: 'danger', text: e instanceof CallError ? annotateErrorWords(e.status, e.error.code, e.error.message) : errorText(e), ...(issues ? { issues } : {}) });
          reload();
        }
      }),
    onSignedIn: reload,
    confirm: setConfirming,
  };
  return { act, busy };
}

/**
 * The Scenario menu's commands and the palette's Scenario group while the recording goes (`live`; `v`: its view, null
 * before it is read).
 */
export function useRecordingCommands(v: RecordViewAnswer | null, live: boolean, act: RecordingActions, setConfirming: (on: boolean) => void): void {
  // L5.11b (critiques H1, M7, L2 of L5.11): while the recording goes — and from the route's first paint, before its view
  // is read (a reload) — the Scenario menu's commands are this screen's, above every other owner: ⌘. stops THIS
  // recording (or says why it cannot), never a run of the scenario in context; Rehearse / Capture / Render send nothing
  // and say why. Once it is over they go back to the status bar's defaults (which name their scenario).
  const stopCommand = () => {
    if (!v) return say('Wait: the recording is still being read');
    if (v.can.stop) return act.stop();
    if (v.job?.stop_requested || v.job?.cancel_requested) return say('The recording is already stopping');
    if (v.started_by === 'cli') return say('This recording was started in a terminal: stop it there');
    say(`Nothing to stop: the recording is ${STATE_WORDS[v.state]?.[0] ?? 'over'}`);
  };
  const waits = (what: string) => () => {
    const open = !v || v.state === 'queued' || v.state === 'preflight' || v.state === 'recording';
    say(open ? `${what} waits while a recording window is open: stop the recording first` : `${what} waits while the recording’s draft is made and checked`);
  };
  useShellCommand('stop', stopCommand, PRIORITY.recording, live);
  useShellCommand('rehearse', waits('Rehearse'), PRIORITY.recording, live);
  useShellCommand('capture', waits('Capture'), PRIORITY.recording, live);
  useShellCommand('render', waits('Render'), PRIORITY.recording, live);
  // The palette's Scenario group is this recording's while it goes (review A-M2 / A-L1): Stop recording (Cancel before the
  // window opens) and Discard…, named after the recording — never the scenario remembered in context.
  const recName = v?.name ?? undefined;
  useScenarioGroup(
    live
      ? [
          { id: 'record-stop', label: v && (v.state === 'queued' || v.state === 'preflight') ? 'Cancel recording' : 'Stop recording', ...(recName ? { hint: recName } : {}), run: stopCommand },
          ...(v?.can.discard ? [{ id: 'record-discard', label: 'Discard…', ...(recName ? { hint: recName } : {}), run: () => setConfirming(true) }] : []),
        ]
      : null,
  );
}
