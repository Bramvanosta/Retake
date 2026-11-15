/**
 * A separate process appending replies to one thread (comments.test.ts: concurrent writers lose no entry).
 * Usage: comment-writer.mts <workspace> <project> <thread id> <writer name> <count>
 */
import { enginePorts } from '../../src/ports.js';
import { openProject, openWorkspace } from '../../src/workspace.js';
import { personScope } from '../../src/store/project-store.js';
import { replyComment } from '../../src/comments.js';
import { diskWorkspaceReads } from '../../src/workspace-reads/disk-reads.js';
import { diskOutputs } from '../../src/outputs/disk-outputs.js';
import { PERSON_POLICY } from '@retake/core';
import { fileFacts } from '@retake/core/io';
import { bindProduct, packageRegistries } from '../../../compose/src/index.js';
import { loadComponentRegistry } from '@retake/components';

// A process of its own: the product bound, as a composition root does.
bindProduct();

const [root, slug, id, name, count] = process.argv.slice(2);
const project = await openProject(await openWorkspace({ root, agent: false, reads: diskWorkspaceReads, outputs: diskOutputs, registries: packageRegistries() }), slug);
for (let i = 0; i < Number(count); i++) await replyComment(project, id, `${name} reply ${i}`, { via: 'cli', name }, { registry: () => loadComponentRegistry({ root: project.root }), renders: diskOutputs.renders, scope: personScope(project.root, enginePorts()), files: fileFacts(PERSON_POLICY), reads: diskWorkspaceReads, seen: undefined });
