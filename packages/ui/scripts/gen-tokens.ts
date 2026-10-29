/** Writes packages/ui/src/app/tokens.css from src/app/tokens.ts (L5.9: the one token file; a test compares the two). */
import { writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokensCss } from '../src/app/tokens.js';

const out = fileURLToPath(new URL('../src/app/tokens.css', import.meta.url));
await writeFile(out, tokensCss());
console.log(`wrote ${relative(process.cwd(), out)}`);
