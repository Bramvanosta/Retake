/**
 * The CLI's composition root hands its ports to every command: what `main(argv, io, ports)` is given reaches a command
 * that builds an engine of its own (`retake jobs`, `retake prune`), never a second set of the product's ports.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enginePorts } from '@retake/engine/shell';
import { memoryJobQueues } from '@retake/engine/testing';
import type { JobQueues } from '@retake/engine';
import { EXIT, main, memoryIo } from '../src/index.js';

let ws: string;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-main-ports-'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('the ports main() is handed', () => {
  it('reach a command that builds its own engine (retake jobs): its queue is made by the ports given', async () => {
    const memory = memoryJobQueues();
    const asked: string[] = [];
    const queues: JobQueues = (root, cli, clock, env) => (asked.push(root), memory(root, cli, clock, env));
    const io = memoryIo();
    const code = await main(['node', 'retake', '--root', ws, 'jobs', '--json'], io, enginePorts({ queues }));
    expect(code).toBe(EXIT.ok);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked).size).toBe(1);
    // The memory queue it made holds the jobs the command listed: none, and nothing of the disk's queue was read.
    expect(await memory.of(asked[0]!)?.ids()).toEqual([]);
  });
});
