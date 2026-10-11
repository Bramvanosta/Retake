/** Writes packages/core/schema/{scenario,project,template,timeline}.schema.json. */
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { writeJsonSchemas } from '../src/schemas/json.js';

const outDir = fileURLToPath(new URL('../schema/', import.meta.url));
const files = await writeJsonSchemas(outDir);
for (const f of files) console.log(`wrote ${relative(process.cwd(), f)}`);
