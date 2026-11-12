import { mcpCommand } from '../commands/mcp.js';
import { jobsCancelCommand, jobsListCommand, jobsStatusCommand } from '../commands/jobs.js';
import type { JobsListOptions, JobsStatusOptions } from '../commands/jobs.js';
import { workerCommand } from '../commands/worker.js';
import type { WorkerCommandOptions } from '../commands/worker.js';
import type { McpCommandOptions } from '../commands/mcp.js';
import { uiCommand } from '../commands/ui.js';
import type { UiCommandOptions } from '../commands/ui.js';
import { collect } from './context.js';
import type { ProgramContext } from './context.js';

/** What serves other clients and runs jobs: mcp, ui, jobs, worker. */
export function registerServiceCommands({ program, action }: ProgramContext): void {
  program
    .command('mcp')
    .description('MCP server over stdio (or HTTP with --http) so a Claude session (Claude Code, Claude desktop) can drive Retake: projects, scenarios, runs, sessions, sandboxes (docs/guide/mcp.md)')
    .option('--print-config', 'print the registration for Claude Code (.mcp.json, claude mcp add) and Claude desktop instead of serving')
    .option('--http', 'serve over Streamable HTTP on 127.0.0.1 (with a stable token in the Retake home) instead of stdio; with --print-config: the HTTP registration')
    .option('--port <n>', 'with --http: listen on this port (default 47820; 0: a free one)')
    .option('--rotate-token', 'with --http: replace the stable token first (every registration must be made again)')
    .option('--json', 'with --http: print one JSON line {type, url, port, pid} on stdout once serving')
    .action(action((u, g, o: McpCommandOptions) => mcpCommand(u, g, o)));

  program
    .command('ui')
    .description('the Studio web app of the workspace, on 127.0.0.1 until Ctrl-C (one server per workspace: run again to reopen it)')
    .option('--port <n>', 'listen on this port (default: a free one)')
    .option('--no-open', 'do not open a browser; print the link only')
    .option('--json', 'print one JSON line {type, v, url, port, pid, reused, player} on stdout and nothing else')
    .option('--supervised', 'for the desktop app: --json --no-open (a v 2 line, then the pending / job_end lines), and stop when stdin closes (the parent quit or died)')
    .action(action((u, g, o: UiCommandOptions) => uiCommand(u, g, o)));

  const jobs = program.command('jobs').description('jobs an MCP client (Claude) started: dry runs, captures, hooks, resets, sign-ins, sandboxes');
  jobs
    .command('list', { isDefault: true })
    .description('jobs of the workspace, newest first, and the worker')
    .option('--project <slug>', 'only the jobs of this project')
    .option('--state <state>', 'only jobs in this state (queued, running, succeeded, failed, cancelled, interrupted; repeatable)', collect)
    .option('--limit <n>', 'at most this many jobs (default 20)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: JobsListOptions) => jobsListCommand(u, g, o)));
  jobs
    .command('status')
    .description('one job: what it runs, its state, progress, result or error and the fix')
    .argument('<id>', 'job id (j_…)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, id: string, o: JobsStatusOptions) => jobsStatusCommand(u, g, id, o)));
  jobs
    .command('cancel')
    .description('cancel a job: a queued one never starts; a running one stops, its teardown and rollbacks still run')
    .argument('<id>', 'job id (j_…)')
    .action(action((u, g, id: string) => jobsCancelCommand(u, g, id)));

  program
    .command('worker', { hidden: true })
    .description('run the jobs worker of the workspace (the MCP server starts it in the background)')
    .option('--idle-exit <ms>', 'exit after this long without a job (default 60000)')
    .option('--once', 'run at most one job, then exit')
    .action(action((u, g, o: WorkerCommandOptions) => workerCommand(u, g, o)));
}
