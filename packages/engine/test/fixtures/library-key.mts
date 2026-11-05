/**
 * A process of its own — as a jobs worker is — that opens a workspace and prints its Library key context's browser
 * part (library-cache.test.ts, L5.15 fixes: the Studio's key and its worker's agree). Arguments: the workspace root.
 */
import { loadTemplate } from '@retake/core';
import { loadComponentRegistry } from '@retake/components';
import { libraryKeyContext, openWorkspace } from '../../src/index.js';

const root = process.argv[2]!;
await openWorkspace({ root });
const ctx = await libraryKeyContext(await loadTemplate('brandx', root), await loadComponentRegistry({ root }));
process.stdout.write(`${JSON.stringify({ browser: ctx.browser })}\n`);
