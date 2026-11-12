/**
 * L7.27: before a person's command runs the shell hooks of a scenario whose hooks an agent wrote — or whose writer
 * cannot be known (engine agent-written.ts) — it lists each one as it will run: the command rendered with the run's
 * template context (vars, pages, the run), its working folder, each of its environment entries, its rollback; a secret
 * token kept as a token, a value filled from an earlier hook's response said to be unknown until the run, every hidden
 * character written out. Then it asks. `--yes` accepts; a terminal asks (default no: nothing runs); without a terminal
 * and without `--yes`, one sentence naming the hooks and the flag, and nothing runs. When the hooks are not going to
 * run (a dry run without them, `--hooks skip`), they are listed and nothing is asked.
 */
import { showHiddenChars, showHiddenCharsLine } from '@retake/core';
import type { AgentWrittenShellHooks, RenderedText, ScenarioShellHook } from '@retake/engine';
import type { Ui } from './ui.js';
import { plural } from './ui.js';

/** How a hook is named in the listing and in the refusal: `setup 1`, `teardown 2 (clean)`, `hook "reset" 1 (project.yaml)`. */
export function shellHookLabel(h: ScenarioShellHook): string {
  const where = h.phase === 'step' ? `hook "${showHiddenCharsLine(h.named?.name ?? '')}" ${h.position}${h.named?.source === 'project' ? ' (project.yaml)' : ''}` : `${h.phase} ${h.position}`;
  const own = h.name !== undefined && h.name !== h.named?.name ? ` (${showHiddenCharsLine(h.name)})` : '';
  return `${where}${own}`;
}

/** Who wrote them, as the header says it. */
function header(scenario: string, f: AgentWrittenShellHooks): string {
  const name = showHiddenCharsLine(scenario);
  const n = `${plural(f.hooks.length, 'shell hook')} ${f.hooks.length === 1 ? 'runs a command' : 'run commands'} on this machine`;
  if ('unknown' in f) return `Retake cannot tell who wrote the hooks of scenario ${name} (${showHiddenCharsLine(f.unknown)}): its ${n}`;
  const at = showHiddenCharsLine(f.at);
  const who = f.by.client === 'ui' ? `through the Studio or by an agent (${at})` : f.by.client === 'mcp' ? `by an agent (through MCP, ${at})` : `by an agent (${showHiddenCharsLine(String(f.by.client))}, ${at})`;
  return `the hooks of scenario ${name} were last written ${who}: its ${n}`;
}

/** A text as it will run: every hidden character written out; its later lines indented under the first. */
function shown(text: string, indent: string): string {
  return showHiddenChars(text).split('\n').join(`\n${indent}`);
}

/** The lines of one rendered text: as it will run, then (when templated) as written, and what is unknown until the run. */
function textLines(head: string, t: RenderedText, indent: string): string[] {
  const out = [`${head}${shown(t.shown, indent)}`];
  if (t.shown !== t.written) out.push(`${indent}as written: ${shown(t.written, `${indent}  `)}`);
  if (t.unknown.length) out.push(`${indent}filled at run time from an earlier hook's response, unknown now: ${t.unknown.map((u) => showHiddenCharsLine(u)).join(', ')}`);
  return out;
}

/** The listing: a header and, per hook, its command, working folder, environment entries and rollback. */
export function agentHooksListing(scenario: string, f: AgentWrittenShellHooks): { header: string; lines: string[] } {
  const lines: string[] = [];
  for (const h of f.hooks) {
    lines.push(...textLines(`  ${shellHookLabel(h)}: `, h.run, '      '));
    if (h.cwd) lines.push(...textLines('      cwd: ', h.cwd, '        '));
    for (const e of h.env) lines.push(...textLines(`      env ${showHiddenCharsLine(e.name)}=`, e.value, '        '));
    if (h.rollback) lines.push(...textLines('      rollback: ', h.rollback, '        '));
  }
  return { header: header(scenario, f), lines };
}

export type AgentHooksVerdict = { ok: true } | { ok: false; message: string };

export interface AskAgentHooksOptions {
  scenario: string;
  /** The hooks run now (true), or why they do not (`dry run`, `--hooks skip`, `--dry`): listed only. */
  run: true | string;
  /** `--yes`: accepted without a question. */
  yes: boolean;
  /** Where the listing goes (the CLI's stderr, or a JSON log event with `--json`). */
  print: (header: string, lines: readonly string[]) => void;
  /** A note (accepted by --yes, listed only). */
  note: (message: string) => void;
}

/** List an agent's shell hooks and take the person's answer: ok to run, or the message that ends the command (exit 1). */
export async function askAgentHooks(ui: Ui, f: AgentWrittenShellHooks, o: AskAgentHooksOptions): Promise<AgentHooksVerdict> {
  const listing = agentHooksListing(o.scenario, f);
  o.print(listing.header, listing.lines);
  if (o.run !== true) {
    o.note(`not run (${o.run}): nothing asked`);
    return { ok: true };
  }
  if (o.yes) {
    o.note(`${f.hooks.length === 1 ? 'the shell hook is' : 'the shell hooks are'} accepted by --yes`);
    return { ok: true };
  }
  const name = showHiddenCharsLine(o.scenario);
  if (!ui.io.canPrompt || !ui.io.confirm) {
    const whose = 'unknown' in f ? 'whose writer Retake cannot tell' : 'last written by an agent';
    return {
      ok: false,
      message: `refused: the shell hooks of scenario ${name} (${f.hooks.map(shellHookLabel).join(', ')}), ${whose}, run only once a person says yes — answer in a terminal, or pass --yes`,
    };
  }
  let yes = false;
  try {
    yes = await ui.io.confirm(`Run ${f.hooks.length === 1 ? 'this shell hook' : `these ${f.hooks.length} shell hooks`}, as listed?`);
  } catch {
    yes = false; // the input closed: no answer is a no
  }
  return yes ? { ok: true } : { ok: false, message: `not run: the shell hooks of scenario ${name} were declined (nothing ran)` };
}
