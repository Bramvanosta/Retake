/**
 * The installed app's Set-up sheet (shell/setup.ts; DESIGN §4p (c); docs/reference/studio-ui.md) — a kit Sheet
 * with one checklist: the workspace, the Retake home, the `retake` command, Claude Code, Claude Desktop, notifications,
 * screen recording (not needed: captures are headless) and the local network. Each step acts only on its own click
 * through the Studio's setup ops (never MCP tools; the desktop app's own server only); Done closes it and remembers it
 * for this version. Paths come from the server: the page never sends one — another folder for the command is picked in
 * the app's native panel. Claude Code's output and Claude Desktop's current entry are other programs' text: shown as
 * text (Txt). When the app runs from a translocated copy, a disk image or /Volumes, the command and Claude steps are
 * off and the sheet says "Move Retake to Applications, then open it again".
 * The focus — the sheet opens on its title (the top in view; a first Return chooses nothing), Help › Uninstall the
 * retake Command… on the confirmation's Uninstall, an inline confirmation on its own button, and back to the item's
 * opener when it closes (else the item's first action, else its title); only Done remembers the sheet (Escape closes it
 * without that). The folder panel is said only once the shell opened it. The process list (Claude Desktop running) is
 * read only while that step is in view, or when the window comes to front.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_NAME } from '../brand.js';
import { CallError, errorText } from '../api.js';
import { setupDone, setupStatus } from '../data/desktop.js';
import { Txt } from '../bits.js';
import { hrefTo } from '../route.js';
import type { Route } from '../route.js';
import { Callout, Checklist, ChecklistItem, Sheet } from '../ui-kit/index.js';
import { SETUP_EVENT, parseSetupDetail, unavailableSentence } from './setup.js';
import type { SetupStatus } from './setup.js';
import { bestEffort } from '../best-effort.js';
import { ClaudeCodeItem, CliItem, DesktopItem, NotificationsItem } from './setup-steps.js';
import type { Act, Busy, Confirm, ConfirmTo, Said, StepProps } from './setup-steps.js';

/** Where the focus goes after the next render: an item (its test id) and, first, one of its buttons (test ids). */
type FocusNext = { item: string; prefer: string[]; always: boolean };
const SHEET = 'dialog[data-testid="setup-sheet"]';
/** The step's item of an action key (`step:op`). */
const ITEM: Record<string, string> = { cli: 'setup-cli', 'claude-code': 'setup-claude-code', desktop: 'setup-claude-desktop', notifications: 'setup-notifications' };
/** The button of an action key. */
const BUTTON: Record<string, string> = {
  'cli:setup_cli_install': 'setup-cli-install',
  'cli:setup_cli_choose': 'setup-cli-choose',
  'cli:setup_cli_remove': 'setup-cli-remove',
  'claude-code:setup_claude_code_run': 'setup-claude-code-run',
  'desktop:setup_claude_desktop_add': 'setup-claude-desktop-add',
  'notifications:setup_notifications': 'setup-notifications-allow',
};

/** Focus `next` in the sheet: a preferred button that is on, else the item's first action that is on, else its title. */
function placeFocus(next: FocusNext): void {
  const d = document.querySelector<HTMLDialogElement>(SHEET);
  const item = d?.querySelector<HTMLElement>(`[data-testid="${next.item}"]`);
  if (!d || !item) return;
  const now = document.activeElement as HTMLElement | null;
  // Not moved when the person put the focus somewhere else in the sheet meanwhile.
  const lost = !now || now === document.body || !d.contains(now) || now === d || (now as HTMLButtonElement).disabled === true || item.contains(now);
  if (!next.always && !lost) return;
  const on = (id: string) => item.querySelector<HTMLElement>(`[data-testid="${id}"]:not(:disabled)`);
  const target = next.prefer.map(on).find((x) => x) ?? item.querySelector<HTMLElement>('.k-check-actions button:not(:disabled)');
  if (target) return target.focus();
  const title = item.querySelector<HTMLElement>('.k-check-title');
  if (title) {
    title.tabIndex = -1;
    title.focus();
  }
}

/** The sheet's state and what opens it: the first start, the shell's event, `#/setup`. */
function useSetupState(route: Route) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<SetupStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const first = useRef(true);
  const polling = useRef<number | null>(null);
  const focusNext = useRef<FocusNext | null>(null);
  /** The Claude Desktop step is in view: the status reads the process list then (at most every 5 s, server-side). */
  const desktopInView = useRef(false);

  const load = useCallback((processes = desktopInView.current): Promise<void> => {
    return setupStatus(processes ? { processes: true } : {}).then(
      (s) => {
        setSt(s);
        setLoadError(null);
      },
      (e: unknown) => setLoadError(errorText(e)),
    );
  }, []);

  // The first start of an installed app opens it once (setup_status `seen` false).
  useEffect(() => {
    if (!first.current) return;
    first.current = false;
    setupStatus().then(
      (s) => {
        setSt(s);
        if (s.available && s.seen === false) setOpen(true);
      },
      () => undefined,
    );
  }, []);
  // Help › Set Up Retake… / Install / Uninstall the retake Command… (the shell's event); `#/setup`.
  useEffect(() => {
    const on = (e: Event) => {
      const s = parseSetupDetail((e as CustomEvent<unknown>).detail);
      if (s === undefined) return;
      setConfirm(s === 'cli-remove' ? 'cli-remove' : null);
      // Help › Uninstall the retake Command…: the confirmation's Uninstall (Keep it when there is nothing to remove);
      // Help › Install the retake Command…: the command's first action.
      if (s) focusNext.current = { item: 'setup-cli', prefer: s === 'cli-remove' ? ['setup-cli-remove-confirm', 'setup-cli-remove-keep'] : [], always: true };
      setOpen(true);
      load();
    };
    window.addEventListener(SETUP_EVENT, on);
    return () => window.removeEventListener(SETUP_EVENT, on);
  }, [load]);
  useEffect(() => {
    if (route.name === 'setup') {
      setOpen(true);
      load();
    }
  }, [route.name, load]);
  return { open, setOpen, st, loadError, busy, setBusy, said, setSaid, confirm, setConfirm, polling, focusNext, desktopInView, load };
}

/** While the sheet is open: the status read again, the Claude Desktop step watched, the focus placed. */
function useSetupWatch({ open, st, busy, confirm, said, polling, focusNext, desktopInView, load }: ReturnType<typeof useSetupState>) {
  // While open: the status again every 2 s (the folder panel's answer, the notification answer, Claude Desktop quitting);
  // the window back in front reads the process list at once (Claude Desktop quit meanwhile).
  useEffect(() => {
    if (!open) return;
    polling.current = window.setInterval(() => load(), 2000);
    const onFocus = () => load(true);
    window.addEventListener('focus', onFocus);
    return () => {
      if (polling.current !== null) window.clearInterval(polling.current);
      polling.current = null;
      window.removeEventListener('focus', onFocus);
    };
  }, [open, load, polling]);
  // The Claude Desktop step in view: only then is the process list read.
  useEffect(() => {
    if (!open || !st?.available) return;
    const d = document.querySelector<HTMLDialogElement>(SHEET);
    const el = d?.querySelector('[data-testid="setup-claude-desktop"]');
    if (!d || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const was = desktopInView.current;
        desktopInView.current = entries.some((x) => x.isIntersecting);
        if (desktopInView.current && !was) load(true);
      },
      { root: d },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      desktopInView.current = false;
    };
  }, [open, st?.available, load, desktopInView]);
  // Where the focus goes once the sheet shows what changed (a section opened, a confirmation opened or closed, an
  // action answered): see placeFocus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a confirmation opened or closed, or an answer said, is a trigger to place the focus asked in focusNext
  useEffect(() => {
    if (!open || !st?.available || busy || !focusNext.current) return;
    const next = focusNext.current;
    const id = window.requestAnimationFrame(() => {
      if (focusNext.current !== next) return;
      focusNext.current = null;
      document.querySelector<HTMLElement>(`${SHEET} [data-testid="${next.item}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      placeFocus(next);
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, st, busy, confirm, said]);
}

export function SetupSheet({ route }: { route: Route }) {
  const sheet = useSetupState(route);
  useSetupWatch(sheet);
  const { open, setOpen, st, loadError, busy, setBusy, said, setSaid, confirm, setConfirm, focusNext, load } = sheet;
  /** Open (or close) an inline confirmation: the focus goes to its first button (or back to its opener). */
  const confirmTo: ConfirmTo = (c, item, prefer) => {
    setConfirm(c);
    focusNext.current = { item, prefer, always: true };
  };

  /** One step's action: `key` (step:op) marks its button busy; `run` calls its op (a literal op name at each call). */
  const act: Act = (key, run, ok) => {
    if (busy) return;
    const step = key.split(':')[0]!;
    setBusy(key);
    setSaid(null);
    // Once it answers, the focus stays on (or goes back to) this action's button, else the item's first action.
    const back = () => (focusNext.current = { item: ITEM[step] ?? 'setup-cli', prefer: BUTTON[key] ? [BUTTON[key]] : [], always: false });
    run().then(
      (d) => {
        setBusy(null);
        setConfirm(null);
        setSaid(ok ? ok(d) : null);
        // The focus is placed once the sheet shows the new status (an Uninstall gone, an Install back), not on the
        // buttons of the status before it, which the reload may remove.
        void load().then(back);
      },
      (e: unknown) => {
        setBusy(null);
        const reason = e instanceof CallError ? (e.error.details?.reason as string | undefined) : undefined;
        if (reason === 'needs_replace' || reason === 'other_app') setConfirm(step === 'desktop' ? 'desktop-replace' : null);
        setSaid({ step, state: 'fail', text: errorText(e) });
        void load().then(back);
      },
    );
  };

  /** Done remembers the sheet for this version; Escape closes it without that (no choice was seen). */
  const close = (id: string) => {
    setOpen(false);
    setSaid(null);
    setConfirm(null);
    focusNext.current = null;
    if (id === 'done' && st?.available) void bestEffort(setupDone(), 'the setup sheet is offered again on the next start when this is lost');
    if (route.name === 'setup') location.hash = hrefTo({ name: 'projects' });
  };

  return (
    <Sheet
      open={open}
      title={`Set up ${APP_NAME}`}
      testId="setup-sheet"
      focusTitle
      escapeAction="escape"
      actions={[{ id: 'done', label: 'Done', variant: 'primary', isDefault: true, testId: 'setup-done' }]}
      onAction={close}
      content={<SetupBody st={st} loadError={loadError} busy={busy} confirm={confirm} said={said} act={act} confirmTo={confirmTo} />}
    >
      {`Each step is optional and happens only when you click it. Help › Set Up ${APP_NAME}… brings this back.`}
    </Sheet>
  );
}

/** The sheet's content: the status being read, why set-up is off, or the checklist of steps. */
function SetupBody({ st, loadError, ...rest }: Omit<StepProps, 'st' | 'placed'> & { st: SetupStatus | null; loadError: string | null }) {
  if (!st) return loadError ? <Callout state="fail" role="alert" title={<Txt text={loadError} />} /> : <p>Reading the set-up…</p>;
  if (!st.available) return <Callout state="idle" role="note" title={unavailableSentence(st.reason)} testId="setup-unavailable" />;
  const placed = st.location === 'ok';
  const step: StepProps = { st, placed, ...rest };
  return (
    <>
      {!placed && <Callout state="attention" role="alert" title={<Txt text={st.location_words ?? ''} />} testId="setup-location" />}
      <Checklist label="Set-up steps">
        <ChecklistItem state="ok" word="Open" title="Workspace" testId="setup-workspace">
          <Txt className="k-mono sh-setup-path" text={st.workspace ?? ''} />
          <p>Your projects live here. File › Open Workspace… changes it.</p>
        </ChecklistItem>
        <ChecklistItem state="ok" word={st.home_from_env ? 'Set by RETAKE_HOME' : 'Default'} title={`${APP_NAME} home`} testId="setup-home">
          <Txt className="k-mono sh-setup-path" text={st.home ?? ''} />
          <p>Signed-in profiles and the approval key live here.</p>
        </ChecklistItem>
        <CliItem {...step} />
        <ClaudeCodeItem {...step} />
        <DesktopItem {...step} />
        <NotificationsItem {...step} />
        <ChecklistItem state="ok" word="Not needed" title="Screen recording" testId="setup-screen">
          <p>{`Captures are headless: ${APP_NAME} never asks for screen recording. retake login and --headed runs open ordinary windows.`}</p>
        </ChecklistItem>
        <ChecklistItem state="idle" word="Pending: asked when needed" title="Local network" testId="setup-network">
          <p>macOS asks the first time a capture opens a site on your local network.</p>
        </ChecklistItem>
      </Checklist>
    </>
  );
}
