/**
 * A separate process appending replies to one thread (comments.test.ts: concurrent writers lose no entry).
 * Usage: comment-writer.mts <workspace> <project> <thread id> <writer name> <count>
 */
import { openProject, openWorkspace, replyComment } from '../../src/index.js';

const [root, slug, id, name, count] = process.argv.slice(2);
const project = await openProject(await openWorkspace({ root }), slug);
for (let i = 0; i < Number(count); i++) await replyComment(project, id, `${name} reply ${i}`, { via: 'cli', name });
