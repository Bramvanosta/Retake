/**
 * L5.16d: the desktop app's update (shell/update.ts; DESIGN §4p (d)) — a kit Button in the status bar ("Update
 * available · vX", then the progress) and a kit Sheet: the version, the release notes (the feed's text, through Txt:
 * never markup), Later · Install and Restart. Install and Restart goes to the shell (`desktop_update`): it downloads and
 * checks the update, waits for this workspace's jobs, asks the quit question about unsaved text, then restarts — the
 * sheet shows each step while the page lives — and a click's refusal in words (review d A-M3: the sheet stays open on a
 * failure or "off"). Nothing installs without the click. The badge stays a live button while a step runs (it reopens
 * the sheet: Later). The notes are a named, keyboard-scrollable region. In the app's window only (AppShell renders it
 * when `inApp`); a server that is not the app's own says `available: false` and nothing shows.
 * The status is read on mount, every 60 s (every 2 s while a step is under way or the sheet is open, every second while
 * it downloads), and at once on the shell's `studio:update` event (Help › Check for Updates… found one: the sheet opens).
 * After an install (hotfix v0.2.6), the restarted app says "Updated to vX" once: the sheet opens by itself on that state
 * (once per version: remembered in the browser's storage, a convenience), the badge stays until it is closed.
 * BL-167: after the click the sheet lists the steps (installSteps: the download, the signature, the jobs, the quit that
 * installs and restarts; the one that failed), the download with its megabytes and percent (a kit Progress; without
 * an announced size, an indeterminate one), and the badge shows the percent while the sheet is closed.
 */
import { useCallback, useEffect, useState } from 'react';
import { call } from '../api.js';
import { Txt } from '../bits.js';
import { APP_NAME } from '../brand.js';
import { Button, Callout, Progress, Shape, Sheet } from '../ui-kit/index.js';
import type { SheetAction } from '../ui-kit/index.js';
import { STEP_MARKS, UPDATE_EVENT, badgeWords, checkedWords, downloadFigure, installSteps, progressWords, sheetShown } from './update.js';
import type { UpdateStatus } from './update.js';

const BUSY = new Set(['checking', 'downloading', 'waiting', 'installing']);
/** The version whose "Updated to vX" was seen (a per-browser convenience). */
const SEEN_KEY = 'retake.update.seen';

export function UpdateControl() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<{ busy: 'install' | 'later' | null; failed: string | null }>({ busy: null, failed: null });
  const load = useCallback(() => {
    call<UpdateStatus>('desktop_update_status').then(
      (s) => setSt(s),
      () => undefined,
    );
  }, []);
  useEffect(() => load(), [load]);
  const fast = open || (st?.state !== undefined && BUSY.has(st.state));
  useEffect(() => {
    const t = window.setInterval(load, st?.state === 'downloading' ? 1000 : fast ? 2000 : 60_000);
    return () => window.clearInterval(t);
  }, [load, fast, st?.state]);
  // Help › Check for Updates… found one: the shell's constant event — read the status, open the sheet.
  useEffect(() => {
    const on = () => {
      load();
      setOpen(true);
    };
    window.addEventListener(UPDATE_EVENT, on);
    return () => window.removeEventListener(UPDATE_EVENT, on);
  }, [load]);
  // Hotfix v0.2.6: the restarted app says "Updated to vX" once — the sheet opens by itself, Close puts it away.
  const [dismissed, setDismissed] = useState(false);
  const updated = st?.state === 'updated' && !dismissed ? st.current : undefined;
  useEffect(() => {
    if (!updated) return;
    let seen: string | null = null;
    try {
      seen = window.localStorage.getItem(SEEN_KEY);
    } catch {
      /* no storage: the sheet opens on each load of this session */
    }
    if (seen !== updated) setOpen(true);
  }, [updated]);
  const badge = dismissed && st?.state === 'updated' ? null : badgeWords(st);
  if (!st?.available) return null;
  const version = st.version ?? '';
  const progress = progressWords(st);
  const steps = installSteps(st);
  const figure = downloadFigure(st);
  const installable = st.installable === true && st.state !== 'downloading' && st.state !== 'installing' && st.state !== 'waiting';
  const onAction = (id: string) => {
    if (id === 'close') {
      setOpen(false);
      if (st.state === 'updated') {
        setDismissed(true);
        try {
          window.localStorage.setItem(SEEN_KEY, st.current ?? '');
        } catch {
          /* no storage */
        }
      }
      return;
    }
    const action = id === 'install' ? 'install' : 'later';
    // Later with nothing under way or failed only closes the sheet (the update stays in the status bar); on a failure it
    // tells the shell it was seen (the remembered failure is cleared).
    if (action === 'later' && !(st.state && (BUSY.has(st.state) || st.state === 'failed'))) {
      setOpen(false);
      return;
    }
    setSent({ busy: action, failed: null });
    call('desktop_update', { action }).then(
      () => {
        setSent({ busy: null, failed: null });
        if (action === 'later') setOpen(false);
        load();
      },
      (e: unknown) => setSent({ busy: null, failed: e instanceof Error ? e.message : String(e) }),
    );
  };
  const actions: SheetAction[] = installable
    ? [
        { id: 'later', label: 'Later', isCancel: true, testId: 'update-later', ...(sent.busy ? { disabled: true } : {}) },
        { id: 'install', label: 'Install and Restart', variant: 'primary', isDefault: true, testId: 'update-install', ...(sent.busy === 'install' ? { busy: true } : sent.busy ? { disabled: true } : {}) },
      ]
    : st.state && BUSY.has(st.state) && st.state !== 'installing'
      ? [
          { id: 'close', label: 'Close', testId: 'update-close' },
          { id: 'later', label: 'Later', isCancel: true, isDefault: true, testId: 'update-later', ...(sent.busy === 'later' ? { busy: true } : {}) },
        ]
      : [{ id: 'close', label: 'Close', isCancel: true, isDefault: true, testId: 'update-close' }];
  const notes = st.untrusted?.notes ?? '';
  return (
    <>
      {badge && (
        <span className="sh-seg sh-update" data-testid="update-badge-wrap">
          {' · '}
          <Button size="sm" variant="ghost" onClick={() => (load(), setOpen(true))} data-testid="update-badge" aria-busy={st.state !== undefined && BUSY.has(st.state) ? true : undefined}>
            {badge}
          </Button>
        </span>
      )}
      <Sheet
        open={open && sheetShown(st) && !(st.state === 'updated' && dismissed)}
        title={st.state === 'updated' ? `${APP_NAME} v${st.current ?? ''}` : version ? `Update ${APP_NAME} to v${version}?` : `Update ${APP_NAME}`}
        actions={actions}
        onAction={onAction}
        testId="update-sheet"
        content={
          <>
            {notes && (
              <div className="sh-update-notes" tabIndex={0} role="region" aria-label="Release notes, from the update feed" data-testid="update-notes">
                <Txt text={notes} />
              </div>
            )}
            {progress && (
              progress.state === 'fail' ? (
                <Callout state="fail" role="alert" title={progress.title} testId="update-progress">
                  {progress.text}
                </Callout>
              ) : (
                <Callout state={progress.state} role="status" title={progress.title} testId="update-progress">
                  {progress.text}
                </Callout>
              )
            )}
            {figure && <Progress label="Download" value={figure.percent} valueText={figure.text} testId="update-download" />}
            {steps && (
              <ol className="sh-update-steps" aria-label="Install and Restart, step by step" data-testid="update-steps">
                {steps.map((step) => (
                  <li key={step.id} className="sh-update-step" data-step={step.id} data-state={step.state} aria-current={step.state === 'running' ? 'step' : undefined}>
                    <span className="sh-update-step-mark" data-state={STEP_MARKS[step.state].mark}>
                      <Shape state={STEP_MARKS[step.state].mark} />
                    </span>
                    <span className="sh-update-step-label">{step.label}</span>
                    <span className="sh-update-step-state">{STEP_MARKS[step.state].word}</span>
                  </li>
                ))}
              </ol>
            )}
            {sent.failed && (
              <Callout state="fail" role="alert" title="The app did not get the click" testId="update-click-failed">
                <Txt text={sent.failed} />
              </Callout>
            )}
          </>
        }
      >
        <Txt className="sh-update-text" text={st.state === 'updated' ? `${checkedWords(st.checked)}` : `You have v${st.current ?? '?'}. Install and Restart downloads the update and checks its signature, waits for this workspace's jobs to end, asks about unsaved text, then restarts ${APP_NAME}. Workspaces, projects and sign-ins are kept. ${checkedWords(st.checked)}`} />
      </Sheet>
    </>
  );
}
