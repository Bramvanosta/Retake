/**
 * `retake history`: the workspace journal (`.retake/journal.jsonl`, engine store/journal.ts) — every authored write
 * (a scenario, the README, a thread, a theme, a component, a project, the workspace's own files, a sandbox scaffold) and
 * every hook run (setup, teardown, step, seed, reset, rollback), who made it (the CLI, the Studio, MCP), when, and the
 * outcome. Read only: nothing here writes, rewrites or removes the journal.
 */
import { printableText } from '@retake/core';
import { readJournal } from '@retake/engine';
import type { JournalEntry } from '@retake/engine';
import { EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

export interface HistoryOptions {
  project?: string;
  /** Only the authored writes. */
  writes?: boolean;
  /** Only the hook runs. */
  hooks?: boolean;
  limit?: string;
  json?: boolean;
}

/** Who, as a person reads it: the channel (`cli`, `studio`, `mcp`), and the client when it says more (`test`). */
function whoText(e: JournalEntry): string {
  const by = e.by ?? { client: '?', channel: '?' };
  return by.client === 'cli' || by.client === 'mcp' || (by.client === 'ui' && by.channel === 'studio') ? String(by.channel) : `${by.channel} (${by.client})`;
}

/** One line of the journal: when, who, what, the outcome. Names from files (paths, hook names) printed as text only. */
export function historyLine(e: JournalEntry): string {
  const at = typeof e.at === 'string' ? e.at.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '?';
  const txt = (s: unknown) => printableText(String(s ?? '')).slice(0, 200);
  const project = e.project !== undefined ? ` ${txt(e.project)}` : '';
  if (e.op === 'hook') {
    const name = e.hook !== undefined ? txt(e.hook) : `#${e.index + 1}`;
    return `${at}  ${whoText(e)}  hook ${txt(e.phase)} ${name}${e.kind ? ` (${txt(e.kind)})` : ''}${project}${e.run ? ` · run ${txt(e.run)}` : ''}  ${txt(e.outcome)}`;
  }
  const files = e.op === 'folder' && e.files ? ` (${e.files.length + (e.files_more ?? 0)} files)` : '';
  return `${at}  ${whoText(e)}  ${e.op === 'folder' ? 'created' : 'wrote'} ${txt(e.what)} ${txt(e.path)}${files}  ${txt(e.outcome)}`;
}

/** `retake history [--project P] [--writes | --hooks] [--limit N] [--json]`: the newest lines of the workspace journal. */
export async function historyCommand(ui: Ui, global: GlobalOptions, opts: HistoryOptions): Promise<ExitCode> {
  const limit = opts.limit === undefined ? 50 : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit must be a positive whole number, got "${opts.limit}"`);
  if (opts.writes && opts.hooks) throw new UsageError('--writes and --hooks: give one of them (neither lists both)');
  const ws = await openWorkspace(global);
  const entries = await readJournal(ws.root, {
    ...(opts.project !== undefined ? { project: opts.project } : {}),
    ...(opts.writes ? { op: 'write' as const } : opts.hooks ? { op: 'hook' as const } : {}),
    limit,
  });
  if (opts.json) {
    ui.result(JSON.stringify({ entries }, null, 2));
    return EXIT.ok;
  }
  if (!entries.length) {
    ui.line(`nothing in the workspace journal${opts.project !== undefined ? ` for ${opts.project}` : ''} yet — it records each scenario, README, thread, theme or component written and each hook run`);
    return EXIT.ok;
  }
  for (const e of entries) ui.result(historyLine(e));
  return EXIT.ok;
}
