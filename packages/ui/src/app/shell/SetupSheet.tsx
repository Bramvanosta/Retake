/**
 * L5.16c: the installed app's Set-up sheet (shell/setup.ts; DESIGN §4p (c); docs/reference/studio-ui.md) — a kit Sheet
 * with one checklist: the workspace, the Retake home, the `retake` command, Claude Code, Claude Desktop, notifications,
 * screen recording (not needed: captures are headless) and the local network. Each step acts only on its own click
 * through the Studio's setup ops (never MCP tools; the desktop app's own server only); Done closes it and remembers it
 * for this version. Paths come from the server: the page never sends one — another folder for the command is picked in
 * the app's native panel. Claude Code's output and Claude Desktop's current entry are other programs' text: shown as
 * text (Txt). When the app runs from a translocated copy, a disk image or /Volumes, the command and Claude steps are
 * off and the sheet says "Move Retake to Applications, then open it again".
 * L5.16c fixes (review c A-M2 / A-L6 / A-L7 / A-L8): the focus — the sheet opens on its title (the top in view; a first
 * Return chooses nothing), Help › Uninstall the retake Command… on the confirmation's Uninstall, an inline confirmation
 * on its own button, and back to the item's opener when it closes (else the item's first action, else its title); only
 * Done remembers the sheet (Escape closes it without that). The folder panel is said only once the shell opened it. The
 * process list (Claude Desktop running) is read only while that step is in view, or when the window comes to front.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { APP_NAME } from '../brand.js';
import { CallError, call, errorText } from '../api.js';
import { Txt } from '../bits.js';
import { hrefTo } from '../route.js';
import type { Route } from '../route.js';
import { Blocker, Button, Callout, Checklist, ChecklistItem, Sheet } from '../ui-kit/index.js';
import { SETUP_EVENT, cliSentence, cliStep, desktopStep, installedElsewhere, linkedByAnotherTool, notificationsStep, panelSentence, parseSetupDetail, pathSentence, runningSentence, unavailableSentence } from './setup.js';
import type { SetupStatus } from './setup.js';

type Busy = string | null;
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
/** The outcome of the last action of a step: its words, and the untrusted output of Claude Code. */
type Said = { step: string; state: 'ok' | 'fail' | 'attention'; text: string; output?: Array<{ line: string; code: number | null; output: string }> };

/** A step's outcome: an alert when it failed, a status otherwise. */
function SaidCallout({ said, testId, children }: { said: Said; testId: string; children: ReactNode }) {
  const title = <Txt text={said.text} />;
  return said.state === 'fail' ? (
    <Callout state="fail" role="alert" title={title} testId={testId}>
      {children}
    </Callout>
  ) : (
    <Callout state={said.state} role="status" title={title} testId={testId}>
      {children}
    </Callout>
  );
}

export function SetupSheet({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<SetupStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const [confirm, setConfirm] = useState<'desktop' | 'desktop-replace' | 'cli-remove' | null>(null);
  const first = useRef(true);
  const polling = useRef<number | null>(null);
  const focusNext = useRef<FocusNext | null>(null);
  /** The Claude Desktop step is in view: the status reads the process list then (at most every 5 s, server-side). */
  const desktopInView = useRef(false);

  const load = useCallback((processes = desktopInView.current) => {
    call<SetupStatus>('setup_status', processes ? { processes: true } : {}).then(
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
    call<SetupStatus>('setup_status').then(
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
  }, [open, load]);
  // The Claude Desktop step in view (review c A-L8): only then is the process list read.
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
  }, [open, st?.available, load]);
  // Where the focus goes once the sheet shows what changed (a section opened, a confirmation opened or closed, an
  // action answered): see placeFocus.
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
  /** Open (or close) an inline confirmation: the focus goes to its first button (or back to its opener). */
  const confirmTo = (c: typeof confirm, item: string, prefer: string[]) => {
    setConfirm(c);
    focusNext.current = { item, prefer, always: true };
  };

  /** One step's action: `key` (step:op) marks its button busy; `run` calls its op (a literal op name at each call). */
  const act = (key: string, run: () => Promise<Record<string, unknown>>, ok?: (d: Record<string, unknown>) => Said | null) => {
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
        back();
        load();
      },
      (e: unknown) => {
        setBusy(null);
        const reason = e instanceof CallError ? (e.error.details?.reason as string | undefined) : undefined;
        if (reason === 'needs_replace' || reason === 'other_app') setConfirm(step === 'desktop' ? 'desktop-replace' : null);
        setSaid({ step, state: 'fail', text: errorText(e) });
        back();
        load();
      },
    );
  };

  /** Done remembers the sheet for this version; Escape closes it without that (review c A-L6: no choice was seen). */
  const close = (id: string) => {
    setOpen(false);
    setSaid(null);
    setConfirm(null);
    focusNext.current = null;
    if (id === 'done' && st?.available) void call('setup_done').catch(() => undefined);
    if (route.name === 'setup') location.hash = hrefTo({ name: 'projects' });
  };

  const placed = st?.location === 'ok';
  const isBusy = (k: string) => busy === k;
  const said_ = (step: string) =>
    said && said.step === step ? (
      <SaidCallout said={said} testId={`setup-${step}-said`}>
        {said.output?.length ? (
          <div className="sh-setup-output">
            {said.output.map((s, i) => (
              <div key={i}>
                <code className="k-mono">
                  <Txt text={`${s.line} → ${s.code === null ? 'stopped' : `exit ${s.code}`}`} />
                </code>
                {s.output ? <Txt className="sh-setup-pre k-mono" text={s.output} /> : null}
              </div>
            ))}
          </div>
        ) : null}
      </SaidCallout>
    ) : null;

  const body = () => {
    if (!st) return loadError ? <Callout state="fail" role="alert" title={<Txt text={loadError} />} /> : <p>Reading the set-up…</p>;
    if (!st.available) return <Callout state="idle" role="note" title={unavailableSentence(st.reason)} testId="setup-unavailable" />;
    const cli = st.cli!;
    const cc = st.claude_code!;
    const cd = st.claude_desktop!;
    // Not moved to Applications: the steps that record the app's path wait (critique H1).
    const held = { state: 'attention' as const, word: 'Blocked: move the app first' };
    const c = placed ? cliStep(cli) : held;
    const d = placed ? desktopStep(cd) : held;
    const ccStep = !placed ? held : cc.claude ? { state: 'idle' as const, word: 'Ready' } : { state: 'idle' as const, word: 'Missing: not found' };
    const n = notificationsStep(st.notifications);
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
          <ChecklistItem
            state={c.state}
            word={c.word}
            title="Command line"
            testId="setup-cli"
            actions={
              <>
                {cli.state !== 'ours' && cli.state !== 'foreign' && !installedElsewhere(cli) && !linkedByAnotherTool(cli) && (
                  <Button variant="primary" disabled={!placed || !!busy} busy={isBusy('cli:setup_cli_install')} data-testid="setup-cli-install" onClick={() => act('cli:setup_cli_install', () => call<Record<string, unknown>>('setup_cli_install', { folder: cli.chosen ? 'chosen' : 'default', replace: cli.state === 'other_app' }), (r) => ({ step: 'cli', state: 'ok', text: `Installed: ${String(r.path)}` }))}>
                    {cli.state === 'other_app' ? 'Replace' : 'Install retake'}
                  </Button>
                )}
                <Button disabled={!placed || !!busy} busy={isBusy('cli:setup_cli_choose')} data-testid="setup-cli-choose" onClick={() => act('cli:setup_cli_choose', () => call<Record<string, unknown>>('setup_cli_choose', {}))}>
                  Choose a Folder…
                </Button>
                {cli.installed && confirm !== 'cli-remove' && (
                  <Button variant="ghost" disabled={!!busy} data-testid="setup-cli-remove" onClick={() => confirmTo('cli-remove', 'setup-cli', ['setup-cli-remove-confirm', 'setup-cli-remove-keep'])}>
                    Uninstall…
                  </Button>
                )}
              </>
            }
          >
            <p>
              <Txt text={cliSentence(cli)} />
            </p>
            {cli.chosen_error && <Callout state="fail" role="alert" title={<Txt text={cli.chosen_error} />} />}
            {panelSentence(cli) && <Callout state="attention" role="status" title={panelSentence(cli)!} testId="setup-cli-panel" />}
            <p>
              <Txt text={pathSentence(cli)} />
            </p>
            {!cli.on_path && !cli.first_runs_this && !linkedByAnotherTool(cli) && <Blocker fix={{ copy: cli.path_line, label: 'Copy line' }} testId="setup-cli-path" />}
            <p>Check it: open a new Terminal window and run retake doctor.</p>
            {confirm === 'cli-remove' && (
              <div className="sh-setup-confirm" role="group" aria-label="Uninstall the command">
                <p>
                  <Txt text={cli.installed ? `Remove ${cli.installed}? Only this app's link is removed: nothing else is touched.` : 'The command is not installed by this app.'} />
                </p>
                <Button variant="destructive" disabled={!cli.installed || !!busy} busy={isBusy('cli:setup_cli_remove')} data-testid="setup-cli-remove-confirm" onClick={() => act('cli:setup_cli_remove', () => call<Record<string, unknown>>('setup_cli_remove', {}), (r) => ({ step: 'cli', state: 'ok', text: `Removed: ${String(r.path)}` }))}>
                  Uninstall
                </Button>
                <Button data-testid="setup-cli-remove-keep" onClick={() => confirmTo(null, 'setup-cli', ['setup-cli-remove'])}>
                  Keep it
                </Button>
              </div>
            )}
            {said_('cli')}
          </ChecklistItem>
          <ChecklistItem
            state={ccStep.state}
            word={ccStep.word}
            title="Claude Code"
            testId="setup-claude-code"
            actions={
              <Button variant="primary" disabled={!placed || !cc.claude || !cc.plugin || !!busy} busy={isBusy('claude-code:setup_claude_code_run')} data-testid="setup-claude-code-run" onClick={() =>
                act('claude-code:setup_claude_code_run', () => call<Record<string, unknown>>('setup_claude_code_run', {}), (r) => {
                  const steps = ((r.untrusted as { steps?: Said['output'] } | undefined)?.steps ?? []).slice(0, 4);
                  return { step: 'claude-code', state: r.ok ? 'ok' : r.timed_out ? 'attention' : 'fail', text: r.ok ? 'Registered with Claude Code' : r.timed_out ? 'Claude Code did not finish within 60 s (it may be asking a question): run the lines in Terminal' : 'Claude Code refused: its output is below', output: steps };
                })
              }>
                Run
              </Button>
            }
          >
            <p>The {APP_NAME} plugin, with this app&apos;s Node.js and engine and this workspace. Run uses {cc.claude ? <Txt className="k-mono" text={cc.claude} /> : 'claude from ~/.local/bin, /opt/homebrew/bin, /usr/local/bin or ~/.claude/local'}; or copy the lines into Terminal.</p>
            <p>
              Claude Code&apos;s settings: <Txt className="k-mono" text={cc.config_dir} />
            </p>
            {cc.lines.length > 0 && <Blocker fix={{ copy: cc.lines.join('\n'), label: 'Copy lines' }} testId="setup-claude-code-lines" />}
            {said_('claude-code')}
          </ChecklistItem>
          <ChecklistItem
            state={d.state}
            word={d.word}
            title="Claude Desktop"
            testId="setup-claude-desktop"
            actions={
              d.state !== 'ok' && cd.state !== 'unreadable' && confirm !== 'desktop' && confirm !== 'desktop-replace' ? (
                <Button disabled={!placed || !cd.folder || !!busy} data-testid="setup-claude-desktop-add" onClick={() => confirmTo(cd.state === 'replace' ? 'desktop-replace' : 'desktop', 'setup-claude-desktop', ['setup-claude-desktop-confirm', 'setup-claude-desktop-cancel'])}>
                  {cd.state === 'replace' ? 'Replace…' : 'Add to Claude Desktop…'}
                </Button>
              ) : undefined
            }
          >
            <p>
              Adds this entry to <Txt className="k-mono" text={cd.file} />
              {cd.folder ? <> (a backup of the file goes to <Txt className="k-mono" text={cd.backups} /> first):</> : ' — the folder is missing: open Claude Desktop once first.'}
            </p>
            <Txt className="sh-setup-pre k-mono" text={cd.entry} />
            <Blocker fix={{ copy: cd.entry, label: 'Copy entry' }} testId="setup-claude-desktop-copy" />
            {st.untrusted?.desktop_current && (
              <>
                <p>The entry there now:</p>
                <Txt className="sh-setup-pre k-mono" text={st.untrusted.desktop_current} />
              </>
            )}
            {st.untrusted?.desktop_problem && <Callout state="fail" role="alert" title={<Txt text={st.untrusted.desktop_problem} />} />}
            {runningSentence(cd.running) && <Callout state="attention" role="status" title={runningSentence(cd.running)!} testId="setup-claude-desktop-running" />}
            {(confirm === 'desktop' || confirm === 'desktop-replace') && (
              <div className="sh-setup-confirm" role="group" aria-label="Add to Claude Desktop">
                <p>
                  <Txt text={confirm === 'desktop-replace' ? `Replace the retake entry in ${cd.file}? A backup is made first.` : `Write this entry into ${cd.file}? A backup is made first; every other setting stays.`} />
                </p>
                <Button variant="primary" disabled={!placed || (cd.running !== false && cd.running !== undefined) || !!busy} busy={isBusy('desktop:setup_claude_desktop_add')} data-testid="setup-claude-desktop-confirm" onClick={() => act('desktop:setup_claude_desktop_add', () => call<Record<string, unknown>>('setup_claude_desktop_add', { replace: confirm === 'desktop-replace' }), (r) => ({ step: 'desktop', state: 'ok', text: r.kind === 'same' ? 'Claude Desktop already has this entry' : `Added: open Claude Desktop again to use it.${r.backup ? ` The file as it was: ${String(r.backup)}` : ''}` }))}>
                  {confirm === 'desktop-replace' ? 'Replace' : 'Add'}
                </Button>
                <Button data-testid="setup-claude-desktop-cancel" onClick={() => confirmTo(null, 'setup-claude-desktop', ['setup-claude-desktop-add'])}>
                  Cancel
                </Button>
              </div>
            )}
            {said_('desktop')}
          </ChecklistItem>
          <ChecklistItem
            state={n.state}
            word={n.word}
            title="Notifications"
            testId="setup-notifications"
            actions={
              st.notifications !== 'on' ? (
                <Button disabled={!!busy} busy={isBusy('notifications:setup_notifications')} data-testid="setup-notifications-allow" onClick={() => act('notifications:setup_notifications', () => call<Record<string, unknown>>('setup_notifications', {}), () => ({ step: 'notifications', state: 'attention', text: `macOS asks you now (or System Settings › Notifications › ${APP_NAME}, if you said no before)` }))}>
                  Allow…
                </Button>
              ) : undefined
            }
          >
            <p>A capture, render or review that ends while the window is not in front tells you.</p>
            {said_('notifications')}
          </ChecklistItem>
          <ChecklistItem state="ok" word="Not needed" title="Screen recording" testId="setup-screen">
            <p>{`Captures are headless: ${APP_NAME} never asks for screen recording. retake login and --headed runs open ordinary windows.`}</p>
          </ChecklistItem>
          <ChecklistItem state="idle" word="Pending: asked when needed" title="Local network" testId="setup-network">
            <p>macOS asks the first time a capture opens a site on your local network.</p>
          </ChecklistItem>
        </Checklist>
      </>
    );
  };

  return (
    <Sheet open={open} title={`Set up ${APP_NAME}`} testId="setup-sheet" focusTitle escapeAction="escape" actions={[{ id: 'done', label: 'Done', variant: 'primary', isDefault: true, testId: 'setup-done' }]} onAction={close} content={body()}>
      {`Each step is optional and happens only when you click it. Help › Set Up ${APP_NAME}… brings this back.`}
    </Sheet>
  );
}
