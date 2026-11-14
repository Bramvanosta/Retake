/**
 * The SQL tests' Postgres (test-support postgres.ts) runs by default wherever it can: RETAKE_TEST_PG as given, else
 * Docker with the image already here (never a pull); otherwise the tests skip and say why — or fail under
 * RETAKE_TEST_PG_REQUIRED=1 (`pnpm test:pg`); RETAKE_TEST_PG=off (the CI tier) skips without asking Docker.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { LIFETIME_S, PG_IMAGE, PG_LABEL, containerRunArgs, postgresAvailability, postgresForTests, removeOnExit } from '@retake/test-support/postgres';

/** A stand-in for `docker`: `info` and `image inspect` answer as told; every call recorded. */
function fakeDocker(o: { running: boolean; image: boolean }) {
  const calls: string[][] = [];
  const run = (...args: string[]) => {
    calls.push(args);
    const ok = args[0] === 'info' ? o.running : args[0] === 'image' ? o.image : false;
    return { status: ok ? 0 : 1, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('the SQL tests: Postgres by default when it can run', () => {
  it('Docker running and the image here: available, a container of its own (given: false); nothing pulled', () => {
    const d = fakeDocker({ running: true, image: true });
    expect(postgresAvailability({}, d.run)).toEqual({ ok: true, given: false });
    expect(d.calls).toEqual([
      ['info', '--format', '{{.ServerVersion}}'],
      ['image', 'inspect', PG_IMAGE, '--format', '{{.Id}}'],
    ]);
    expect(d.calls.flat()).not.toContain('pull');
  });

  it('RETAKE_TEST_PG names a server: used as given, Docker not asked; RETAKE_TEST_PG=off: skipped, Docker not asked', () => {
    const d = fakeDocker({ running: false, image: false });
    expect(postgresAvailability({ RETAKE_TEST_PG: 'postgres://x@127.0.0.1/y' }, d.run)).toEqual({ ok: true, given: true });
    expect(postgresAvailability({ RETAKE_TEST_PG: 'off' }, d.run)).toEqual({ ok: false, reason: expect.stringMatching(/^RETAKE_TEST_PG=off/) });
    expect(d.calls).toEqual([]);
  });

  it('no Docker, or no image: skipped with the reason (the docker pull to run), said once in the output', () => {
    expect(postgresAvailability({}, fakeDocker({ running: false, image: true }).run)).toEqual({ ok: false, reason: 'Docker is not running (or not installed) and RETAKE_TEST_PG is not set' });
    const noImage = postgresAvailability({}, fakeDocker({ running: true, image: false }).run);
    expect(noImage).toEqual({ ok: false, reason: `the image ${PG_IMAGE} is not on this machine (the tests never pull one: docker pull ${PG_IMAGE})` });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      expect(postgresForTests('x.test.ts', {}, fakeDocker({ running: true, image: false }).run)).toEqual({ ok: false });
      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0]![0]).toBe(`x.test.ts: the tests against Postgres are skipped: ${(noImage as { reason: string }).reason}`);
    } finally {
      info.mockRestore();
    }
  });

  it('under RETAKE_TEST_PG_REQUIRED=1 (pnpm test:pg) a missing Postgres fails the file instead of skipping it', () => {
    expect(() => postgresForTests('x.test.ts', { RETAKE_TEST_PG_REQUIRED: '1' }, fakeDocker({ running: false, image: false }).run)).toThrow(
      /^x\.test\.ts: no Postgres for the SQL tests: Docker is not running/,
    );
    expect(postgresForTests('x.test.ts', { RETAKE_TEST_PG_REQUIRED: '1' }, fakeDocker({ running: true, image: true }).run)).toEqual({ ok: true });
  });

  it('a container never pulls the image, is labelled, has a lifetime cap and publishes on loopback only', () => {
    const args = containerRunArgs('retake-pg-test-abc123', 'pw');
    expect(args.slice(0, 5)).toEqual(['run', '-d', '--rm', '--pull', 'never']);
    expect(args).toEqual(expect.arrayContaining(['--name', 'retake-pg-test-abc123', '--label', PG_LABEL, '-p', '127.0.0.1::5432']));
    expect(args.slice(args.indexOf('--entrypoint'))).toEqual(['--entrypoint', 'timeout', PG_IMAGE, String(LIFETIME_S), 'docker-entrypoint.sh', 'postgres']);
    expect(args).not.toContain('pull');
  });

  it('the container is removed when the process ends or is stopped before the afterAll; stop() takes the hooks off', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      for (const event of ['exit', 'disconnect', 'SIGINT', 'SIGTERM'] as const) {
        const d = fakeDocker({ running: true, image: true });
        const proc = new EventEmitter();
        removeOnExit('retake-pg-test-abc123', d.run, proc);
        proc.emit(event, event);
        expect(d.calls, event).toEqual([['rm', '-f', '-v', 'retake-pg-test-abc123']]);
        expect(
          ['exit', 'disconnect', 'SIGINT', 'SIGTERM'].map((e) => proc.listenerCount(e)),
          event,
        ).toEqual([0, 0, 0, 0]);
      }
      expect(exit.mock.calls).toEqual([[130], [143]]);
      const d = fakeDocker({ running: true, image: true });
      const proc = new EventEmitter();
      const off = removeOnExit('retake-pg-test-abc123', d.run, proc);
      off();
      proc.emit('exit');
      expect(d.calls).toEqual([]);
    } finally {
      exit.mockRestore();
    }
  });
});
