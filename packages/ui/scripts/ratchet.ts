/**
 * Lowers test/legacy-controls.json to the legacy screens' current kit-only findings (L5.9, review A-M3: scripts/kit-ratchet.ts).
 * A row only ever goes DOWN: one that dropped is lowered, one at 0 or of a file gone is removed; a file above its row (or
 * a new file with any finding) is reported and nothing is written — move it onto the kit instead.
 * `pnpm -F @retake/ui ratchet`
 */
import { writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { TABLE_FILE, ratchetFindings, readTable } from './kit-ratchet.js';

const table = await readTable();
const found = await ratchetFindings();
const over = [...found].filter(([f, x]) => x.length > (table[f] ?? 0));
if (over.length) {
  for (const [f, x] of over) console.error(`${f}: ${x.length} findings, the table allows ${table[f] ?? 0}\n  ${x.join('\n  ')}`);
  process.exit(1);
}
const next = Object.fromEntries([...found].filter(([, x]) => x.length > 0).map(([f, x]) => [f, x.length]));
const lowered = Object.keys(table).filter((f) => next[f] !== table[f]);
await writeFile(TABLE_FILE, `${JSON.stringify(next, null, 2)}\n`);
console.log(lowered.length ? `lowered ${lowered.map((f) => `${f} ${table[f]} → ${next[f] ?? 'removed'}`).join(', ')} in ${relative(process.cwd(), TABLE_FILE)}` : 'the table is current');
