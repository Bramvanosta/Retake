/**
 * `retake comment add | list | reply | resolve | reopen` (L3.6): frame comments on renders, written as the channel `cli`
 * (trust author: whoever types the command). Only this command creates and reopens threads; Claude replies to and
 * resolves them through MCP. Texts shown on the terminal are printable only (they are written by people and agents).
 */
import { commentAuthorName, printableText, regionProblem } from '@retake/core';
import type { CommentAuthor, CommentRegion } from '@retake/core';
import { EngineError, addComment, defaultAuthorName, listComments, reopenComment, replyComment, resolveComment } from '@retake/engine';
import type { CommentListView, CommentView, CommentWritten } from '@retake/engine';
import { CliError, EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { plural } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';
import { fileFacts } from '@retake/core/io';

export interface CommentAddOptions {
  at?: string;
  frame?: string;
  marker?: string;
  region?: string;
  scenario?: string;
  author?: string;
  json?: boolean;
}

export interface CommentListOptions {
  scenario?: string;
  render?: string;
  status?: 'open' | 'resolved' | 'all';
  limit?: string;
  json?: boolean;
}

export interface CommentWriteOptions {
  author?: string;
  note?: string;
  render?: string;
  json?: boolean;
}

function author(given: string | undefined): CommentAuthor {
  if (given === undefined) return { via: 'cli', name: defaultAuthorName() };
  const name = commentAuthorName(given);
  if (!name) throw new UsageError('--author: a printable name of 1 to 80 characters');
  return { via: 'cli', name };
}

/** `--region x,y,w,h` (0..1 of the frame). */
export function parseRegion(v: string): CommentRegion {
  const parts = v.split(',').map((p) => p.trim());
  if (parts.length !== 4 || parts.some((p) => !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(p))) throw new UsageError(`--region ${v}: four numbers x,y,w,h, 0..1 of the frame (e.g. 0.67,0.42,0.12,0.08)`);
  const [x, y, w, h] = parts.map(Number);
  const region = { x, y, w, h };
  const problem = regionProblem(region);
  if (problem) throw new UsageError(`--region ${v}: ${problem}`);
  return region;
}

/** EngineError → a usage error when an argument is wrong, else a failure with its fix. */
async function engineCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EngineError) {
      const message = `${e.message}${e.fix ? `\n  fix: ${e.fix}` : ''}`;
      if (e.details?.argument !== undefined) throw new UsageError(message);
      throw new CliError(message);
    }
    throw e;
  }
}

/** A stored text on the terminal: line by line, printable only. */
function textLines(text: string, indent: string): string[] {
  return text.split('\n').map((l) => `${indent}${printableText(l)}`);
}

function anchorLine(t: CommentView): string {
  const a = t.anchor;
  const parts = [`${a.kind} ${a.segment}`];
  if (a.step_ref) parts.push(`step ${a.step_ref}${a.action ? ` (${a.action})` : ''}`);
  else if (a.action) parts.push(a.action);
  if (a.area) parts.push(`area ${a.area}`);
  if (a.component) parts.push(a.component);
  if (a.marker) parts.push(`marker ${a.marker}`);
  if (a.overlays?.length) parts.push(`overlays ${a.overlays.join(', ')}`);
  if (a.transition) parts.push(`${a.transition.kind} ${a.transition.from ?? '?'} → ${a.transition.to ?? '?'}`);
  return parts.join(' · ');
}

/** A proposal's state as `comment list` prints it (L4.6; the Studio's and the MCP's words). */
const PROPOSAL_STATE_WORDS: Record<NonNullable<CommentView['entries'][number]['proposal']>['state'], string> = {
  pending: 'pending',
  applied: 'applied',
  undone: 'applied, then undone',
  superseded: 'superseded',
  stale: 'stale',
};

function printThread(ui: Ui, t: CommentView): void {
  const k = ui.c;
  const status = t.status === 'open' ? k.yellow('open') : k.green('resolved');
  ui.line(`${k.bold(t.id)} ${status} · ${t.render_id} frame ${t.frame} (${t.timecode})${t.region ? ` region ${t.region.x},${t.region.y},${t.region.w},${t.region.h}` : ''}${t.render_present ? '' : k.dim(' · render no longer on disk')}`);
  ui.line(k.dim(`  ${anchorLine(t)}`));
  ui.line(`  ${printableText(t.untrusted.author)} (${t.via}), ${t.created_at}:`);
  for (const l of textLines(t.untrusted.text, '    ')) ui.line(l);
  t.entries.forEach((e, i) => {
    const u = t.untrusted.entries[i];
    const what =
      e.kind === 'resolve'
        ? `resolved${e.render_id ? ` with ${e.render_id}` : ''}`
        : e.kind === 'reopen'
          ? 'reopened'
          : e.kind === 'apply'
            ? `applied the proposal of ${e.applies ?? '?'}`
            : e.proposal
              ? `replied with a proposal (${PROPOSAL_STATE_WORDS[e.proposal.state]}, +${e.proposal.added} −${e.proposal.removed})`
              : 'replied';
    ui.line(`  ${k.dim(e.id)} ${printableText(u?.author ?? '?')} (${e.via}) ${what}, ${e.created_at}${u?.text ? ':' : ''}`);
    if (u?.text) for (const l of textLines(u.text, '    ')) ui.line(l);
  });
  if (t.newer_renders.length) ui.line(k.dim(`  newer renders: ${t.newer_renders.join(', ')}`));
  ui.line(k.dim(`  ${ui.path(t.file)}${t.still ? ` · still ${ui.path(t.still)}` : ' · no still'}`));
}

/** `retake comment add <project> <render> (--at <s> | --frame <n> | --marker <name>) [--region x,y,w,h] "text"`. */
export async function commentAddCommand(ui: Ui, global: GlobalOptions, projectArg: string, render: string, text: string, opts: CommentAddOptions): Promise<ExitCode> {
  const given = [opts.at, opts.frame, opts.marker].filter((v) => v !== undefined).length;
  if (given !== 1) throw new UsageError('name the frame with exactly one of --at <seconds>, --frame <n> or --marker <name>');
  let frame: number | undefined;
  let at: number | undefined;
  if (opts.frame !== undefined) {
    if (!/^\d+$/.test(opts.frame)) throw new UsageError(`--frame ${opts.frame}: an output frame number (0-based)`);
    frame = Number(opts.frame);
  }
  if (opts.at !== undefined) {
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(opts.at)) throw new UsageError(`--at ${opts.at}: seconds from the start of the render (e.g. 12.4)`);
    at = Number(opts.at);
  }
  const region = opts.region !== undefined ? parseRegion(opts.region) : undefined;
  const by = author(opts.author);
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  const added = await engineCall(() =>
    addComment(
      project,
      {
        render,
        ...(opts.scenario !== undefined ? { scenario: opts.scenario } : {}),
        ...(frame !== undefined ? { frame } : {}),
        ...(at !== undefined ? { at_s: at } : {}),
        ...(opts.marker !== undefined ? { marker: opts.marker } : {}),
        ...(region ? { region } : {}),
        text,
      },
      by,
      undefined,
      ws.policy,
    ),
  );
  if (opts.json) {
    ui.result(JSON.stringify(added, null, 2));
    return EXIT.ok;
  }
  const t = added.thread;
  ui.ok(`comment ${ui.c.bold(t.id)} on ${t.render_id} frame ${t.frame} (${t.timecode}): ${anchorLine(t)}`);
  ui.line(ui.c.dim(`  ${ui.path(t.file)}${t.still ? ` · still ${ui.path(t.still)}` : ''}`));
  for (const w of added.warnings) ui.warn(w);
  return EXIT.ok;
}

/** `retake comment list <project> [--scenario] [--render] [--status]`. */
export async function commentListCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: CommentListOptions): Promise<ExitCode> {
  let limit: number | undefined;
  if (opts.limit !== undefined) {
    if (!/^[1-9]\d*$/.test(opts.limit)) throw new UsageError(`--limit ${opts.limit}: a whole number from 1`);
    limit = Number(opts.limit);
  }
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  const list: CommentListView = await engineCall(() =>
    listComments(project, {
      ...(opts.scenario !== undefined ? { scenario: opts.scenario } : {}),
      ...(opts.render !== undefined ? { render: opts.render } : {}),
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      ...(limit !== undefined ? { limit } : {}),
    }),
  );
  if (opts.json) {
    ui.result(JSON.stringify(list, null, 2));
    return EXIT.ok;
  }
  const status = opts.status ?? 'open';
  if (!list.threads.length) ui.line(`no ${status === 'all' ? '' : `${status} `}comment in ${project.slug}${opts.scenario ? ` · ${opts.scenario}` : ''}${opts.render ? ` on ${opts.render}` : ''}`);
  for (const t of list.threads) printThread(ui, t);
  if (list.total > list.threads.length) ui.line(ui.c.dim(`${list.threads.length} of ${plural(list.total, 'thread')} shown (--limit)`));
  for (const p of list.problems) ui.warn(p);
  return EXIT.ok;
}

function printWritten(ui: Ui, what: string, w: CommentWritten, json?: boolean): ExitCode {
  if (json) {
    ui.result(JSON.stringify(w, null, 2));
    return EXIT.ok;
  }
  ui.ok(`${what} ${ui.c.bold(w.thread.id)} (entry ${w.entry}): now ${w.thread.status}`);
  return EXIT.ok;
}

/** `retake comment reply <project> <id> "text"`. */
export async function commentReplyCommand(ui: Ui, global: GlobalOptions, projectArg: string, id: string, text: string, opts: CommentWriteOptions): Promise<ExitCode> {
  const by = author(opts.author);
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  return printWritten(ui, 'replied to', await engineCall(() => replyComment(project, id, text, by, { files: fileFacts(ws.policy) })), opts.json);
}

/** `retake comment resolve <project> <id> --note "…" [--render <id>]`. */
export async function commentResolveCommand(ui: Ui, global: GlobalOptions, projectArg: string, id: string, opts: CommentWriteOptions): Promise<ExitCode> {
  if (opts.note === undefined) throw new UsageError('--note "<what was changed>" is required');
  const by = author(opts.author);
  const project = await openProject(await openWorkspace(global), projectArg);
  const w = await engineCall(() => resolveComment(project, id, { note: opts.note as string, ...(opts.render !== undefined ? { render_id: opts.render } : {}) }, by));
  return printWritten(ui, 'resolved', w, opts.json);
}

/** `retake comment reopen <project> <id> [--note "…"]`. */
export async function commentReopenCommand(ui: Ui, global: GlobalOptions, projectArg: string, id: string, opts: CommentWriteOptions): Promise<ExitCode> {
  const by = author(opts.author);
  const project = await openProject(await openWorkspace(global), projectArg);
  return printWritten(ui, 'reopened', await engineCall(() => reopenComment(project, id, opts.note, by)), opts.json);
}
