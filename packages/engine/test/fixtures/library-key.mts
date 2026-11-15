/**
 * A process of its own — as a jobs worker is — that opens a workspace and prints its Library key context's browser
 * part (library-cache.test.ts, L5.15 fixes: the Studio's key and its worker's agree). Arguments: the workspace root.
 */
import { fileFacts, loadTemplate } from '@retake/core/io';
import { loadComponentRegistry } from '@retake/components';
import { libraryKeyContext } from '../../src/library.js';
import { openWorkspace } from '../../src/workspace.js';
import { diskWorkspaceReads } from '../../src/workspace-reads/disk-reads.js';
import { diskOutputs } from '../../src/outputs/disk-outputs.js';
import { packageRegistries } from '../../src/registries/package-registries.js';

const root = process.argv[2]!;
const ws = await openWorkspace({ root, agent: false, reads: diskWorkspaceReads, outputs: diskOutputs, registries: packageRegistries() });
const ctx = await libraryKeyContext(await loadTemplate('brandx', root, { files: fileFacts(ws.policy) }), await loadComponentRegistry({ root }), { policy: ws.policy });
process.stdout.write(`${JSON.stringify({ browser: ctx.browser })}\n`);
