/**
 * The engine façade's shape: the keys of the object createEngine returns, in order, and the keys of each of its
 * sub-APIs (projects, scenarios, runs, …), held against a list. The façade is assembled from one builder per sub-API
 * (src/facade/): moving a method between them, dropping one or adding one changes this list — on purpose only.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine, FileJobQueue } from '../src/index.js';
import * as facade from '../src/engine.js';

let ws: string;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-engine-facade-'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
});
afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

/** Each key of the façade: a value or a method (its name), or a sub-API — a plain object of methods (its keys, in order). */
function shape(o: Record<string, unknown>): Array<string | [string, string[]]> {
  return Object.entries(o).map(([k, v]) => {
    const subApi = v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && Object.values(v).every((m) => typeof m === 'function');
    return subApi ? [k, Object.keys(v as object)] : k;
  });
}

const SHAPE: Array<string | [string, string[]]> = [
  'root',
  'queue',
  'jobFiles',
  'workspace',
  'cli',
  'info',
  'usage',
  ['projects', ['list', 'get', 'create', 'updateReadme', 'prune', 'board']],
  ['scenarios', ['get', 'validate', 'check', 'view', 'actions', 'save', 'edit', 'fromScript']],
  ['runs', ['list', 'status', 'submit', 'cancel', 'pause', 'thumbs', 'poster']],
  ['jobs', ['get', 'list', 'events', 'cancel', 'wait', 'position', 'worker']],
  ['hooks', ['submit']],
  ['env', ['reset']],
  ['auth', ['status', 'login', 'cancelSignIn', 'forScenario']],
  ['renders', ['plan', 'submit', 'status', 'ofScenario', 'frame', 'outline']],
  ['timeline', ['view']],
  ['reviews', ['submit', 'get', 'image']],
  ['exports', ['submit']],
  ['templates', ['list', 'get', 'create', 'fromSite', 'site', 'view', 'edit', 'copy', 'files', 'sites', 'preview']],
  ['components', ['list', 'get', 'validate', 'create', 'preview', 'library', 'libraryRender']],
  ['inspect', ['submit', 'get']],
  ['record', ['submit', 'get', 'view', 'annotate', 'save', 'discard', 'stop', 'list']],
  'thumbnail',
  ['comments', ['list', 'get', 'add', 'reply', 'resolve', 'reopen', 'anchorAt', 'apply', 'proposal', 'counts']],
  ['sandbox', ['status', 'up', 'reset']],
];

describe('the engine façade', () => {
  it('keeps its keys and the keys of every sub-API, in order', async () => {
    const engine = await createEngine({ root: ws, client: 'cli', autoStartWorker: false });
    expect(shape(engine as unknown as Record<string, unknown>)).toEqual(SHAPE);
    // The values of the façade are this workspace's.
    expect(engine.info().root).toBe(engine.root);
    expect(engine.workspace.root).toBe(engine.root);
    // The queue is handed as its port: the type has no `files` member (the object is still the file queue, which has
    // one), so its paths are handed beside it — this workspace's jobs folder, and that very queue's own paths, not
    // those of a second queue on the same folder.
    // @ts-expect-error — the port has no `files` member: the paths are `engine.jobFiles`
    void engine.queue.files;
    expect(engine.jobFiles.dir).toBe(join(engine.root, '.retake', 'jobs'));
    expect(engine.queue).toBeInstanceOf(FileJobQueue);
    expect(engine.jobFiles).toBe((engine.queue as FileJobQueue).files);
    expect(engine.cli).toMatch(/^retake -C /);
  });

  it('engine.ts exports the same values (its types are checked by tsc: index.ts re-exports each by name)', () => {
    expect(Object.keys(facade).sort()).toEqual(['ENGINE_API_VERSION', 'agentTrust', 'createEngine']);
    expect(facade.ENGINE_API_VERSION).toBe(1);
    expect(facade.agentTrust('cli')).toBe(false);
    expect(facade.agentTrust('mcp')).toBe(true);
  });
});
