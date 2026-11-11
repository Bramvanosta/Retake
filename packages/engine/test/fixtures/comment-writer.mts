/**
 * A separate process appending replies to one thread (comments.test.ts: concurrent writers lose no entry).
 * Usage: comment-writer.mts <workspace> <project> <thread id> <writer name> <count>
 */
import { enginePorts, openProject, openWorkspace, personScope, replyComment } from '../../src/index.js';
import { PERSON_POLICY } from '@retake/core';
import { fileFacts } from '@retake/core/io';

const [root, slug, id, name, count] = process.argv.slice(2);
const project = await openProject(await openWorkspace({ root, agent: false }), slug);
for (let i = 0; i < Number(count); i++) await replyComment(project, id, `${name} reply ${i}`, { via: 'cli', name }, { scope: personScope(project.root, enginePorts()), files: fileFacts(PERSON_POLICY) });
