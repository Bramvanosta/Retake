/**
 * A separate process submitting through an engine of one client on a workspace (admission-processes.test.ts: two
 * processes at once pass an admission rule once). It prints `ready` once its engine is open, then reads one request per
 * line on stdin — `{"op":"run"|"render"|"export", "req":{…}}` — and answers each on stdout, one JSON line:
 * `{"ok":true,"job":"j_…"}` or `{"ok":false,"code":…,"message":…,"details":…}`. Usage: admission-submitter.mts <workspace> <client>
 */
import { createInterface } from 'node:readline';
import { createEngine } from '../../src/index.js';
import type { EngineClient } from '../../src/index.js';

const [root, client] = process.argv.slice(2);
const engine = await createEngine({ root: root!, client: client as EngineClient, autoStartWorker: false });
const say = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
say('ready');
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { op, req } = JSON.parse(line) as { op: 'run' | 'render' | 'export'; req: never };
  try {
    const r = op === 'run' ? await engine.runs.submit(req) : op === 'render' ? await engine.renders.submit(req) : await engine.exports.submit(req);
    say({ ok: true, job: r.job.id });
  } catch (e) {
    const err = e as { code?: string; message: string; details?: unknown };
    say({ ok: false, code: err.code, message: err.message, details: err.details });
  }
}
