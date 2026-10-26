/**
 * A separate process writing one file with `if_match` on command (storage-write-lock.test.ts: two writers of one
 * version across processes). Reads JSON lines `{at, ref, text, ifMatch}` from stdin: waits until `at` (ms since the
 * epoch, so both processes write at the same moment), writes, and prints `{ok: true}` or `{ok: false, code}`.
 * Usage: text-writer.mts <project folder>
 */
import { createInterface } from 'node:readline';
import { LocalStorage } from '../../src/index.js';

const storage = new LocalStorage(process.argv[2]);
process.stdout.write('ready\n');
for await (const line of createInterface({ input: process.stdin })) {
  const { at, ref, text, ifMatch } = JSON.parse(line) as { at: number; ref: string; text: string; ifMatch: string };
  while (Date.now() < at) {
    /* spin to the agreed moment */
  }
  const out = await storage.writeText(ref, text, { ifMatch }).then(
    () => ({ ok: true }),
    (e: unknown) => ({ ok: false, code: (e as { code?: string }).code ?? String(e) }),
  );
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
