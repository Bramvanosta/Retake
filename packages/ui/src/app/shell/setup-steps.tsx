/**
 * The Set-up sheet's steps (SetupSheet.tsx): the command line, Claude Code, Claude Desktop and notifications items,
 * each with its actions, its inline confirmation and the outcome of its last action.
 */
import type { ReactNode } from 'react';
import { APP_NAME } from '../brand.js';
import { setupClaudeCodeRun, setupClaudeDesktopAdd, setupCliChoose, setupCliInstall, setupCliRemove, setupNotifications } from '../data/desktop.js';
import { Txt } from '../bits.js';
import { Blocker, Button, Callout, ChecklistItem } from '../ui-kit/index.js';
import { cliSentence, cliStep, desktopStep, installedElsewhere, notificationsStep, panelSentence, pathSentence, runningSentence } from './setup.js';
import type { SetupStatus } from './setup.js';

export type Busy = string | null;
/** The outcome of the last action of a step: its words, and the untrusted output of Claude Code. */
export type Said = { step: string; state: 'ok' | 'fail' | 'attention'; text: string; output?: Array<{ line: string; code: number | null; output: string }> };

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

export type Confirm = 'desktop' | 'desktop-replace' | 'cli-remove' | null;
/** One step's action: `key` (step:op) marks its button busy; `run` calls its op; `ok` words its answer. */
export type Act = (key: string, run: () => Promise<Record<string, unknown>>, ok?: (d: Record<string, unknown>) => Said | null) => void;
/** Open (or close) an inline confirmation, and where the focus goes then. */
export type ConfirmTo = (c: Confirm, item: string, prefer: string[]) => void;
/** What a step's item shows and does: the status, the sheet's state, its actions. */
export type StepProps = { st: SetupStatus; placed: boolean; busy: Busy; confirm: Confirm; said: Said | null; act: Act; confirmTo: ConfirmTo };
/** Not moved to Applications: the steps that record the app's path wait. */
const HELD = { state: 'attention' as const, word: 'Blocked: move the app first' };

/** A step's outcome under its item, with the lines Claude Code ran and their output. */
function StepSaid({ said, step }: { said: Said | null; step: string }) {
  if (!said || said.step !== step) return null;
  return (
    <SaidCallout said={said} testId={`setup-${step}-said`}>
      {said.output?.length ? (
        <div className="sh-setup-output">
          {said.output.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one step's output lines in order, text only: the index is the line number
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
  );
}

/** The command line step: Install (or Replace), Choose a Folder…, Uninstall… and its confirmation, the PATH line. */
export function CliItem({ st, placed, busy, confirm, said, act, confirmTo }: StepProps) {
  const cli = st.cli!;
  const c = placed ? cliStep(cli) : HELD;
  return (
    <ChecklistItem
      state={c.state}
      word={c.word}
      title="Command line"
      testId="setup-cli"
      actions={
        <>
          {cli.state !== 'ours' && cli.state !== 'foreign' && !installedElsewhere(cli) && (
            <Button
              variant="primary"
              disabled={!placed || !!busy}
              busy={busy === 'cli:setup_cli_install'}
              data-testid="setup-cli-install"
              onClick={() =>
                act(
                  'cli:setup_cli_install',
                  () => setupCliInstall({ folder: cli.chosen ? 'chosen' : 'default', replace: cli.state === 'other_app' }),
                  (r) => ({ step: 'cli', state: 'ok', text: `Installed: ${String(r.path)}` }),
                )
              }
            >
              {cli.state === 'other_app' ? 'Replace' : 'Install retake'}
            </Button>
          )}
          <Button disabled={!placed || !!busy} busy={busy === 'cli:setup_cli_choose'} data-testid="setup-cli-choose" onClick={() => act('cli:setup_cli_choose', () => setupCliChoose({}))}>
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
      {!cli.on_path && <Blocker fix={{ copy: cli.path_line, label: 'Copy line' }} testId="setup-cli-path" />}
      <p>Check it: open a new Terminal window and run retake doctor.</p>
      {confirm === 'cli-remove' && (
        // biome-ignore lint/a11y/useSemanticElements: an inline confirmation (text and two buttons); <fieldset> would bring its own border, padding and min-width
        <div className="sh-setup-confirm" role="group" aria-label="Uninstall the command">
          <p>
            <Txt text={cli.installed ? `Remove ${cli.installed}? Only this app's link is removed: nothing else is touched.` : 'The command is not installed by this app.'} />
          </p>
          <Button
            variant="destructive"
            disabled={!cli.installed || !!busy}
            busy={busy === 'cli:setup_cli_remove'}
            data-testid="setup-cli-remove-confirm"
            onClick={() =>
              act(
                'cli:setup_cli_remove',
                () => setupCliRemove({}),
                (r) => ({ step: 'cli', state: 'ok', text: `Removed: ${String(r.path)}` }),
              )
            }
          >
            Uninstall
          </Button>
          <Button data-testid="setup-cli-remove-keep" onClick={() => confirmTo(null, 'setup-cli', ['setup-cli-remove'])}>
            Keep it
          </Button>
        </div>
      )}
      <StepSaid said={said} step="cli" />
    </ChecklistItem>
  );
}

/** Claude Code's answer to Run, in words, with its first output lines. */
function claudeCodeSaid(r: Record<string, unknown>): Said {
  const steps = ((r.untrusted as { steps?: Said['output'] } | undefined)?.steps ?? []).slice(0, 4);
  return {
    step: 'claude-code',
    state: r.ok ? 'ok' : r.timed_out ? 'attention' : 'fail',
    text: r.ok
      ? 'Registered with Claude Code'
      : r.timed_out
        ? 'Claude Code did not finish within 60 s (it may be asking a question): run the lines in Terminal'
        : 'Claude Code refused: its output is below',
    output: steps,
  };
}

/** The Claude Code step: Run registers the plugin; the lines to copy instead. */
export function ClaudeCodeItem({ st, placed, busy, said, act }: StepProps) {
  const cc = st.claude_code!;
  const ccStep = !placed ? HELD : cc.claude ? { state: 'idle' as const, word: 'Ready' } : { state: 'idle' as const, word: 'Missing: not found' };
  return (
    <ChecklistItem
      state={ccStep.state}
      word={ccStep.word}
      title="Claude Code"
      testId="setup-claude-code"
      actions={
        <Button
          variant="primary"
          disabled={!placed || !cc.claude || !cc.plugin || !!busy}
          busy={busy === 'claude-code:setup_claude_code_run'}
          data-testid="setup-claude-code-run"
          onClick={() => act('claude-code:setup_claude_code_run', () => setupClaudeCodeRun({}), claudeCodeSaid)}
        >
          Run
        </Button>
      }
    >
      <p>
        The {APP_NAME} plugin, with this app&apos;s Node.js and engine and this workspace. Run uses{' '}
        {cc.claude ? <Txt className="k-mono" text={cc.claude} /> : 'claude from ~/.local/bin, /opt/homebrew/bin, /usr/local/bin or ~/.claude/local'}; or copy the lines into Terminal.
      </p>
      <p>
        Claude Code&apos;s settings: <Txt className="k-mono" text={cc.config_dir} />
      </p>
      {cc.lines.length > 0 && <Blocker fix={{ copy: cc.lines.join('\n'), label: 'Copy lines' }} testId="setup-claude-code-lines" />}
      <StepSaid said={said} step="claude-code" />
    </ChecklistItem>
  );
}

/** The Claude Desktop step: the entry to add, the one there now, Add… (or Replace…) and its confirmation. */
export function DesktopItem({ st, placed, busy, confirm, said, act, confirmTo }: StepProps) {
  const cd = st.claude_desktop!;
  const d = placed ? desktopStep(cd) : HELD;
  return (
    <ChecklistItem
      state={d.state}
      word={d.word}
      title="Claude Desktop"
      testId="setup-claude-desktop"
      actions={
        d.state !== 'ok' && cd.state !== 'unreadable' && confirm !== 'desktop' && confirm !== 'desktop-replace' ? (
          <Button
            disabled={!placed || !cd.folder || !!busy}
            data-testid="setup-claude-desktop-add"
            onClick={() => confirmTo(cd.state === 'replace' ? 'desktop-replace' : 'desktop', 'setup-claude-desktop', ['setup-claude-desktop-confirm', 'setup-claude-desktop-cancel'])}
          >
            {cd.state === 'replace' ? 'Replace…' : 'Add to Claude Desktop…'}
          </Button>
        ) : undefined
      }
    >
      <p>
        Adds this entry to <Txt className="k-mono" text={cd.file} />
        {cd.folder ? (
          <>
            {' '}
            (a backup of the file goes to <Txt className="k-mono" text={cd.backups} /> first):
          </>
        ) : (
          ' — the folder is missing: open Claude Desktop once first.'
        )}
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
        // biome-ignore lint/a11y/useSemanticElements: an inline confirmation (text and two buttons); <fieldset> would bring its own border, padding and min-width
        <div className="sh-setup-confirm" role="group" aria-label="Add to Claude Desktop">
          <p>
            <Txt
              text={
                confirm === 'desktop-replace'
                  ? `Replace the retake entry in ${cd.file}? A backup is made first.`
                  : `Write this entry into ${cd.file}? A backup is made first; every other setting stays.`
              }
            />
          </p>
          <Button
            variant="primary"
            disabled={!placed || (cd.running !== false && cd.running !== undefined) || !!busy}
            busy={busy === 'desktop:setup_claude_desktop_add'}
            data-testid="setup-claude-desktop-confirm"
            onClick={() =>
              act(
                'desktop:setup_claude_desktop_add',
                () => setupClaudeDesktopAdd({ replace: confirm === 'desktop-replace' }),
                (r) => ({
                  step: 'desktop',
                  state: 'ok',
                  text: r.kind === 'same' ? 'Claude Desktop already has this entry' : `Added: open Claude Desktop again to use it.${r.backup ? ` The file as it was: ${String(r.backup)}` : ''}`,
                }),
              )
            }
          >
            {confirm === 'desktop-replace' ? 'Replace' : 'Add'}
          </Button>
          <Button data-testid="setup-claude-desktop-cancel" onClick={() => confirmTo(null, 'setup-claude-desktop', ['setup-claude-desktop-add'])}>
            Cancel
          </Button>
        </div>
      )}
      <StepSaid said={said} step="desktop" />
    </ChecklistItem>
  );
}

/** The notifications step: Allow… asks macOS. */
export function NotificationsItem({ st, busy, said, act }: StepProps) {
  const n = notificationsStep(st.notifications);
  return (
    <ChecklistItem
      state={n.state}
      word={n.word}
      title="Notifications"
      testId="setup-notifications"
      actions={
        st.notifications !== 'on' ? (
          <Button
            disabled={!!busy}
            busy={busy === 'notifications:setup_notifications'}
            data-testid="setup-notifications-allow"
            onClick={() =>
              act(
                'notifications:setup_notifications',
                () => setupNotifications({}),
                () => ({ step: 'notifications', state: 'attention', text: `macOS asks you now (or System Settings › Notifications › ${APP_NAME}, if you said no before)` }),
              )
            }
          >
            Allow…
          </Button>
        ) : undefined
      }
    >
      <p>A capture, render or review that ends while the window is not in front tells you.</p>
      <StepSaid said={said} step="notifications" />
    </ChecklistItem>
  );
}
