/**
 * L5.14b: doctor's "Captures first" line — the takes filming now on this Mac for this user (counted, never named: in
 * this workspace or elsewhere), the markers' folder, whether a running render can be slowed (background priority), the
 * cap; WARN when the folder cannot be used or a marker's owner is not a Retake process. The system probe makes nothing.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isTakeOwnerCommand } from '@retake/engine';
import { capturesCheck, systemProbes } from '../src/commands/doctor.js';
import type { CapturesProbe } from '../src/commands/doctor.js';

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'retake-doctor-captures-'));
});
const children: ChildProcess[] = [];
afterAll(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  if (base) await rm(base, { recursive: true, force: true });
});

const ENGINE = fileURLToPath(new URL('../../engine/dist/index.js', import.meta.url));
/** A process (the script `file`) that opens a filming marker of workspace `root`, says so, and waits. */
async function markerOwner(file: string, root: string): Promise<ChildProcess> {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(
    file,
    `import(${JSON.stringify(ENGINE)}).then(async (e) => { e.FilmingMarker.open({ root: ${JSON.stringify(root)}, source: 'cli', owner: await e.selfIdentity() }); process.stdout.write('ready'); setInterval(() => {}, 1000); });\n`,
  );
  const c = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(c);
  await new Promise<void>((r, j) => {
    c.stdout!.on('data', () => r());
    c.on('exit', (code) => j(new Error(`marker owner exited (${code})`)));
  });
  return c;
}

const probe = (o: Partial<CapturesProbe> = {}): CapturesProbe => ({ dir: '/scratch/retake-captures', override: false, exists: true, takes: [], qos: true, capMin: 60, ...o });
const take = (o: Partial<CapturesProbe['takes'][number]> = {}) => ({ here: false, paused: false, capped: false, retake: true, ...o });

describe('doctor: Captures first (L5.14b)', () => {
  it('nothing filming: ok, the folder (per user), background priority, the cap', () => {
    expect(capturesCheck(probe())).toEqual({
      status: 'ok',
      name: 'Captures first',
      detail:
        'no take films now · markers: /scratch/retake-captures (this user on this Mac) · a render running when a take starts is slowed (background priority) · cap 60 min (RETAKE_CAPTURE_HOLD_MAX_MIN)',
    });
    expect(capturesCheck(probe({ exists: false, override: true, qos: false })).detail).toBe(
      'no take films now · markers: /scratch/retake-captures (set by RETAKE_CAPTURES_DIR; made by the first take) · no background priority here: a running render is not slowed, new heavy jobs only wait · cap 60 min (RETAKE_CAPTURE_HOLD_MAX_MIN)',
    );
  });

  it('takes filming: counted by where (never named), the paused ones apart, the ones past the cap said', () => {
    const c = capturesCheck(probe({ takes: [take({ here: true }), take(), take({ capped: true }), take({ paused: true })] }));
    expect(c.status).toBe('ok');
    expect(c.detail).toMatch(
      /^3 takes film now \(1 in this workspace, 2 elsewhere on this Mac\): renders, reviews, exports and previews wait for them and run at background priority meanwhile — 1 past the 60-min cap, which holds nothing any more · 1 paused \(holding nothing\) · markers: /,
    );
  });

  it('warns: a folder captures first cannot use; a marker whose owner is not a Retake process', () => {
    const bad = capturesCheck(probe({ problem: 'the captures folder /scratch/retake-captures is open to other users (mode 755): captures first is off' }));
    expect(bad).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^the captures folder .* captures first is off · markers: /), hint: expect.stringMatching(/mode 0700/) });
    const foreign = capturesCheck(probe({ takes: [take({ retake: false })] }));
    expect(foreign).toMatchObject({
      status: 'warn',
      detail: expect.stringMatching(/^a filming marker whose owner is not a Retake process · 1 take films now/),
      hint: expect.stringMatching(/holds renders for up to 60 min; if no take films, remove the k_\*\.json files in /),
    });
  });

  it("review A L3: a marker's owner is a Retake one only when its command line is a jobs worker or `retake run`", () => {
    for (const cmd of [
      '/usr/local/bin/node /Applications/Retake.app/Contents/Resources/app/packages/engine/dist/worker-main.js --root /w',
      'node /w/packages/engine/dist/worker-main.js',
      'node /w/packages/cli/dist/bin.js -C /w run demo quote',
      'node /usr/local/bin/retake run demo quote --headed',
    ]) {
      expect(isTakeOwnerCommand(cmd), cmd).toBe(true);
    }
    for (const cmd of ['node /tmp/tool.js', 'node /w/packages/cli/dist/bin.js render demo quote', '/bin/sh -c retake-like', 'node /tmp/worker-main.json', 'python3 run.py run']) {
      expect(isTakeOwnerCommand(cmd), cmd).toBe(false);
    }
  });

  it("the system probe: a worker's marker is a Retake take of this workspace, another node process's is not; an absent folder is not made", async () => {
    const root = join(base, 'ws');
    await mkdir(root, { recursive: true });
    const captures = systemProbes().captures!;
    const worker = await markerOwner(join(base, 'bin', 'worker-main.js'), root);
    const other = await markerOwner(join(base, 'other', 'tool.js'), root);
    try {
      const p = await captures(root);
      expect(p).toMatchObject({ override: true, exists: true, capMin: 60 });
      expect(p.takes.map((t) => t.retake).sort()).toEqual([false, true]);
      expect(p.takes.every((t) => t.here && !t.paused && !t.capped)).toBe(true);
      expect(p.qos).toBe(process.platform === 'darwin');
      expect(capturesCheck(p)).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^a filming marker whose owner is not a Retake process/) });
    } finally {
      worker.kill('SIGTERM');
      other.kill('SIGTERM');
    }
    const saved = process.env.RETAKE_CAPTURES_DIR;
    process.env.RETAKE_CAPTURES_DIR = join(base, 'never-made');
    try {
      const p = await captures(root);
      expect(p).toMatchObject({ exists: false, takes: [] });
      expect(existsSync(join(base, 'never-made'))).toBe(false);
    } finally {
      process.env.RETAKE_CAPTURES_DIR = saved;
    }
  });
});
