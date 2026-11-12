import { Option } from 'commander';
import { commentAddCommand, commentListCommand, commentReopenCommand, commentReplyCommand, commentResolveCommand } from '../commands/comment.js';
import type { CommentAddOptions, CommentListOptions, CommentWriteOptions } from '../commands/comment.js';
import type { ProgramContext } from './context.js';

/** Frame comments on renders: comment. */
export function registerCommentCommands({ program, action }: ProgramContext): void {
  const comment = program.command('comment').description('frame comments on renders: a comment on one frame (optionally a region), replies, resolution with the render that answers it (comments/<scenario>/<id>.json; Claude reads and answers them through MCP)');
  comment
    .command('add')
    .description('comment on one frame of a render: the anchor (segment, scene, step, component) is computed from the render\'s plan and the still kept in .retake/comments/')
    .argument('<project>', 'project slug or directory')
    .argument('<render>', 'render id (e.g. quote-v3), or "latest"')
    .argument('<text>', 'the comment (at most 2000 characters)')
    .option('--at <seconds>', 'the frame on screen at this time of the render (the printed duration: the last frame)')
    .option('--frame <n>', 'output frame number (0-based)')
    .option('--marker <name>', 'the frame of a marker (a `mark:` step): its done frame, else its start (a name on several steps: use --frame)')
    .option('--region <x,y,w,h>', 'the commented region, 0..1 of the frame (e.g. 0.67,0.42,0.12,0.08)')
    .option('--scenario <name>', 'with "latest": the latest render of this scenario')
    .option('--author <name>', 'your name (default $RETAKE_AUTHOR, else your user name)')
    .option('--json', 'print the thread as JSON')
    .action(action((u, g, p: string, r: string, t: string, o: CommentAddOptions) => commentAddCommand(u, g, p, r, t, o)));
  comment
    .command('list')
    .description('threads of a project: anchor, texts, entries, still')
    .argument('<project>', 'project slug or directory')
    .option('--scenario <name>', 'only the threads of this scenario')
    .option('--render <id>', 'only the threads made on this render (an id or "latest")')
    .addOption(new Option('--status <status>', 'open (default), resolved or all').choices(['open', 'resolved', 'all']))
    .option('--limit <n>', 'at most this many threads')
    .option('--json', 'machine-readable output')
    .action(action((u, g, p: string, o: CommentListOptions) => commentListCommand(u, g, p, o)));
  comment
    .command('reply')
    .description('reply on a thread')
    .argument('<project>', 'project slug or directory')
    .argument('<id>', 'thread id (c_…)')
    .argument('<text>', 'the reply (at most 2000 characters)')
    .option('--author <name>', 'your name (default $RETAKE_AUTHOR, else your user name)')
    .option('--json', 'print the thread as JSON')
    .action(action((u, g, p: string, id: string, t: string, o: CommentWriteOptions) => commentReplyCommand(u, g, p, id, t, o)));
  comment
    .command('resolve')
    .description('resolve an open thread, optionally with the later render that answers it')
    .argument('<project>', 'project slug or directory')
    .argument('<id>', 'thread id (c_…)')
    .option('--note <text>', 'what was changed (required)')
    .option('--render <id>', 'the render that answers it: a later render of the same scenario and variant (an id or "latest")')
    .option('--author <name>', 'your name (default $RETAKE_AUTHOR, else your user name)')
    .option('--json', 'print the thread as JSON')
    .action(action((u, g, p: string, id: string, o: CommentWriteOptions) => commentResolveCommand(u, g, p, id, o)));
  comment
    .command('reopen')
    .description('reopen a resolved thread (its resolution does not answer it)')
    .argument('<project>', 'project slug or directory')
    .argument('<id>', 'thread id (c_…)')
    .option('--note <text>', 'why')
    .option('--author <name>', 'your name (default $RETAKE_AUTHOR, else your user name)')
    .option('--json', 'print the thread as JSON')
    .action(action((u, g, p: string, id: string, o: CommentWriteOptions) => commentReopenCommand(u, g, p, id, o)));
}
