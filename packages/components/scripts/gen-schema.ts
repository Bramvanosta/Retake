/** Writes packages/components/schema/component.schema.json (editor autocompletion of component.yaml). */
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { writeComponentJsonSchema } from '../src/schema-json.js';

const outDir = fileURLToPath(new URL('../schema/', import.meta.url));
const file = await writeComponentJsonSchema(outDir);
console.log(`wrote ${relative(process.cwd(), file)}`);
