/**
 * L5.12d: the desktop app's quit question as a kit Sheet (shell/quit.ts; DESIGN §4j). It opens on `studio:quit` even
 * over another modal (the palette, a sheet: the top layer stacks it), acks `shown` once the dialog is open, one frame
 * painted and the window visible (a minimised window or another Space acks when it shows — before that the shell's
 * native alert takes over after 1.5 s), answers through `desktop_answer`, and closes on `studio:quit-close` of its id.
 * A re-sent question (a second ⌘Q) acks again. The words are the shell's data: through Txt (the kit's slots).
 * L5.12d fixes (review A-L3): an answer keeps the sheet open, its button busy, until `desktop_answer` settles — then it
 * closes; a failed one says so in the sheet and the question stays answerable (the shell's own timers still apply: a
 * second ⌘Q re-asks, natively 10 s after the first ack).
 */
import { useEffect, useState } from 'react';
import { call } from '../api.js';
import { Txt } from '../bits.js';
import { Callout, Sheet } from '../ui-kit/index.js';
import { QUIT_CLOSE_EVENT, QUIT_EVENT, parseQuitDetail, quitActions } from './quit.js';
import type { QuitQuestion } from './quit.js';

const sendShown = (id: string) => void call('desktop_answer', { id, shown: true }).catch(() => undefined);

/** An answer in flight (`busy`: the action chosen) or the last one failed. */
type Sent = { id: string; busy: 'proceed' | 'cancel' | null; failed: boolean };

export function QuitSheet() {
  // A new object per dispatch (the same id re-sent acks again).
  const [q, setQ] = useState<QuitQuestion | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  useEffect(() => {
    const onQuit = (e: Event) => {
      const p = parseQuitDetail((e as CustomEvent<unknown>).detail);
      if (!p) return;
      setQ(p);
      // Another question: nothing of the last one's answer carries over (the same id re-sent keeps it).
      setSent((cur) => (cur && cur.id === p.id ? cur : null));
    };
    const onClose = (e: Event) => {
      const id = ((e as CustomEvent<{ id?: unknown } | null>).detail ?? {}).id;
      setQ((cur) => (cur && cur.id === id ? null : cur));
    };
    window.addEventListener(QUIT_EVENT, onQuit);
    window.addEventListener(QUIT_CLOSE_EVENT, onClose);
    return () => {
      window.removeEventListener(QUIT_EVENT, onQuit);
      window.removeEventListener(QUIT_CLOSE_EVENT, onClose);
    };
  }, []);
  // The ack: the Sheet's own effect has run (showModal) — then one painted frame, the window visible.
  useEffect(() => {
    if (!q) return;
    let done = false;
    let raf = 0;
    const open = () => document.querySelector<HTMLDialogElement>('dialog[data-testid="quit-sheet"]')?.open === true;
    const ack = () => {
      if (done || !open() || document.visibilityState !== 'visible') return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => {
          if (done || !open() || document.visibilityState !== 'visible') return;
          done = true;
          sendShown(q.id);
        });
      });
    };
    ack();
    document.addEventListener('visibilitychange', ack);
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', ack);
    };
  }, [q]);
  const busy = sent && q && sent.id === q.id ? sent.busy : null;
  const failed = !!(sent && q && sent.id === q.id && sent.failed);
  const onAction = (action: string) => {
    if (!q || busy) return;
    const a = action === 'proceed' ? 'proceed' : 'cancel';
    const asked = q;
    const qid = q.id;
    setSent({ id: qid, busy: a, failed: false });
    call('desktop_answer', { id: qid, answer: a }).then(
      () => {
        setSent((cur) => (cur && cur.id === qid ? null : cur));
        // This dispatch answered: it closes (a question dispatched since stays — the shell closes what it answered).
        setQ((cur) => (cur === asked ? null : cur));
      },
      () => setSent((cur) => (cur && cur.id === qid ? { id: qid, busy: null, failed: true } : cur)),
    );
  };
  // A failed answer: the focus back on the default action (its button was busy, then off).
  useEffect(() => {
    if (failed) document.querySelector<HTMLElement>('dialog[data-testid="quit-sheet"] [data-default="yes"]:not(:disabled)')?.focus();
  }, [failed]);
  const actions = q ? quitActions(q).map((x) => (busy ? { ...x, ...(x.id === busy ? { busy: true } : { disabled: true }) } : x)) : [];
  return (
    <Sheet
      open={q !== null}
      title={q ? <Txt text={q.title} /> : ''}
      actions={actions}
      onAction={onAction}
      destructive={q?.destructive ?? false}
      alert
      testId="quit-sheet"
      content={
        failed ? (
          <Callout state="fail" role="alert" title="The app did not get the answer" testId="quit-failed">
            Answer again, or press ⌘Q again.
          </Callout>
        ) : undefined
      }
    >
      {q ? <Txt className="sh-quit-text" text={q.text} /> : null}
    </Sheet>
  );
}
