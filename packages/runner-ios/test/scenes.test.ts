/**
 * The iOS scene loop (src/scenes.ts, src/steps.ts) with a fake driver and a fake run: a scene's deep link goes
 * through the driver's `open` (checked against the environment's schemes once templated), its still and steps are
 * recorded as runner-web records them, every tap is logged as a touch on its event, the app must stay in front, a
 * failed step leaves the device's picture and the redacted element tree, an optional one is listed, `--until` stops,
 * typing goes in chunks paced to the step, a secret value is never typed, and a driver that did not answer in time
 * stops the run even on an optional step.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PACING } from '@retake/core/project';
import { parseScenario } from '@retake/core/scenario';
import type { Scenario } from '@retake/core/scenario';
import { parseYaml } from '@retake/core/base';
import type { NormalizedStep } from '@retake/core/language';
import type { CaptureRun, CaptureTools } from '@retake/runner-web/types';
import { playScenes } from '../src/scenes.js';
import type { IosStage } from '../src/steps.js';
import { typingChunk } from '../src/steps.js';
import { statusBarTime } from '../src/ios-driver.js';
import { DriverError } from '../src/driver-client.js';

type Call = { op: string; body: Record<string, unknown> };

class Failure extends Error {
  constructor(
    message: string,
    readonly o: Record<string, unknown>,
  ) {
    super(message);
  }
}

const TOOLS: CaptureTools = {
  stepFailure: (message, o) => new Failure(message, o),
  runnerError: (message) => new Error(message),
  isCancelled: () => false,
  errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
  describeStep: (s: NormalizedStep) => `${s.action} ${JSON.stringify(s.args)}`,
  caption: (c) => (c === undefined ? undefined : typeof c === 'string' ? { text: c } : c),
  templated: (fn) => fn(),
  untilSteps: (e) => e,
  throwIfAborted: () => undefined,
  sleep: async () => undefined,
};

/** A fake driver: each op answered by `answer` (default: a tap on a button at 100, 200). */
function fakeClient(answer: (c: Call) => Record<string, unknown> | Error = () => ({})) {
  const calls: Call[] = [];
  const cmd = async (op: string, body: Record<string, unknown> = {}) => {
    const c = { op, body };
    calls.push(c);
    const now = Date.now();
    const a = answer(c);
    if (a instanceof Error) throw a;
    const base: Record<string, unknown> = { ok: true, t_begin: now, t_end: now + 300 };
    if (op === 'tap')
      Object.assign(base, {
        exists: true,
        hittable: true,
        frame: { x: 50, y: 180, w: 100, h: 40 },
        label: 'Add',
        value: '',
        t_act: now + 10,
        point: body.x !== undefined ? { x: body.x, y: body.y } : { x: 100, y: 200 },
      });
    if (op === 'state') base.state = 'runningForeground';
    if (op === 'find') Object.assign(base, { exists: true, hittable: true, frame: { x: 10, y: 300, w: 200, h: 44 } });
    if (op === 'tree') base.tree = 'Application, label: secret-value-123';
    return { ...base, ...a } as never;
  };
  return { calls, client: { cmd } };
}

function fakeRun(yaml: string, until: CaptureRun['until'] = null) {
  // Read as an iOS environment's scenario would be (its deep links are not web pages): the schema, not the web checks.
  const parsed = parseScenario(yaml);
  const sc = parsed.scenario ?? (parseYaml(yaml).value as Scenario);
  const t0 = Date.now();
  const timeline = { scenes: [] as unknown[], events: [] as Array<Record<string, unknown>>, markers: [] as unknown[], warnings: [] as string[] };
  const record = { screenshots: [] as string[], steps_done: 0, warnings: [] as string[], hooks: { setup: 'none', teardown: 'none' } } as unknown as CaptureRun['record'];
  const run = {
    sc,
    env: { name: 'simulator', pages: {}, ios: { app: 'com.example.app', device: 'iPhone 17 Pro', schemes: ['northfield'] } },
    template: { pages: {}, vars: {}, run: { id: 'r', dir: '/runs/r' }, hooks: {} },
    record,
    until,
    pacing: DEFAULT_PACING,
    screenshotsDir: '/runs/r/screenshots',
    signal: new AbortController().signal,
    clock: { now: () => (Date.now() - t0) / 1000, at: (w: number) => (w - t0) / 1000 },
    timeline: {
      ...timeline,
      addScene: (s: unknown) => timeline.scenes.push(s),
      addEvent: (e: Record<string, unknown>) => timeline.events.push(e),
      addMarker: (m: unknown) => timeline.markers.push(m),
      warn: (m: string) => timeline.warnings.push(m),
    },
    secrets: { redactDeep: <T>(x: T) => x, redactText: (s: string) => s.replace('secret-value-123', '••••'), contains: (s: string) => s.includes('secret-value-123') },
    files: { saveRecord: async () => undefined },
    emit: () => undefined,
  } as unknown as CaptureRun;
  return { run, timeline, record };
}

function stage(run: CaptureRun, client: IosStage['client'], shots: string[] = []): IosStage {
  return {
    run,
    tools: TOOLS,
    client,
    screen: { width: 402, height: 874 },
    bundleId: 'com.example.app',
    schemes: ['northfield'],
    touches: [],
    screenshot: async (f) => void shots.push(f),
    timeoutS: 15,
    warned: new Set(),
  };
}

const ok = (yaml: string) => `version: 1\nvideo: v\nscenes:\n${yaml}`;

describe('the iOS scene loop', () => {
  it('a deep link, the still, a tap logged on its event with its box and point, a mark, the app checked after each step', async () => {
    const { run, timeline } = fakeRun(
      ok(`  - id: buy
    caption: Buy
    open: "northfield://product/NF-1"
    steps:
      - click: {testid: add-to-quote}
        mark: added
      - click: Send
`),
    );
    const { calls, client } = fakeClient();
    const st = stage(run, client);
    await playScenes(st);
    expect(calls.map((c) => c.op)).toEqual(['open', 'tap', 'state', 'tap', 'state']);
    expect(calls[0].body).toEqual({ url: 'northfield://product/NF-1' });
    expect(calls[1].body).toEqual({ query: { id: 'add-to-quote' }, timeout_ms: 15000 });
    expect(calls[3].body).toEqual({ query: { text: 'Send' }, timeout_ms: 15000 });
    expect(timeline.events.map((e) => e.action)).toEqual(['scene_open', 'scene_still', 'click', 'click']);
    const tap = timeline.events[2];
    expect(tap).toMatchObject({ target: { desc: 'testid="add-to-quote"', bbox: { x: 50, y: 180, w: 100, h: 40 } }, point: { x: 100, y: 200 }, mark: 'added', page: 'simulator', status: 'ok' });
    expect(timeline.markers).toEqual([expect.objectContaining({ name: 'added', scene: 'buy', step: 0 })]);
    expect(timeline.scenes).toEqual([expect.objectContaining({ id: 'buy', caption: { text: 'Buy' }, page: 'simulator', status: 'ok' })]);
    expect(st.touches).toHaveLength(2);
    expect(st.touches[0]).toMatchObject({ kind: 'tap', x: 100, y: 200, event: tap });
    expect(st.touches[0].t_end - st.touches[0].t_act).toBeCloseTo(0.29, 2);
  });

  it('a deep link of a scheme the environment does not list is refused (scene step -1), nothing opened', async () => {
    const { run } = fakeRun(ok(`  - id: a\n    open: "otherapp://x"\n    steps: [{wait: 0.1}]\n`));
    const { calls, client } = fakeClient();
    await expect(playScenes(stage(run, client))).rejects.toMatchObject({ o: { scene: 'a', step: -1, action: 'open' }, message: expect.stringMatching(/otherapp/) });
    expect(calls.find((c) => c.op === 'open')).toBeUndefined();
  });

  it("a failed step: the device's picture, the element tree (secrets masked); an optional one is listed and the run goes on", async () => {
    const { run, record } = fakeRun(ok(`  - id: a\n    steps:\n      - click: Missing\n        optional: true\n      - click: Gone\n`));
    const { client } = fakeClient((c) => (c.op === 'tap' ? new (class extends Error {})('tap: no element matches the query') : {}));
    const shots: string[] = [];
    const err = (await playScenes(stage(run, client, shots)).then(
      () => null,
      (e: unknown) => e,
    )) as Failure;
    expect(record.optional_failures).toEqual([expect.objectContaining({ scene: 'a', step: 0, action: 'click', screenshot: '/runs/r/screenshots/error-a-00-click.png' })]);
    expect(err).toBeInstanceOf(Failure);
    expect(err.o).toMatchObject({ scene: 'a', step: 1, action: 'click', screenshot: '/runs/r/screenshots/error-a-01-click.png', dom: 'Application, label: ••••' });
    expect(shots).toHaveLength(2);
  });

  it('a driver that did not answer in time stops the run, even on an optional step (what the app shows is unknown)', async () => {
    const { run, record } = fakeRun(ok(`  - id: a\n    steps:\n      - click: Slow\n        optional: true\n      - click: Next\n`));
    const { calls, client } = fakeClient((c) => (c.op === 'tap' ? new DriverError('the iOS driver did not answer tap within 45 s', 'timeout') : {}));
    await expect(playScenes(stage(run, client))).rejects.toMatchObject({ o: { scene: 'a', step: 0 }, message: expect.stringMatching(/did not answer tap/) });
    expect(record.optional_failures).toBeUndefined();
    expect(calls.filter((c) => c.op === 'tap')).toHaveLength(1);
  });

  it('a type step whose text holds a secret value fails before anything is tapped or typed', async () => {
    const { run } = fakeRun(ok(`  - id: a\n    steps:\n      - type: {into: {placeholder: Notes}, text: "code secret-value-123"}\n`));
    const { calls, client } = fakeClient();
    await expect(playScenes(stage(run, client))).rejects.toThrow(/would type a secret value/);
    expect(calls.filter((c) => c.op === 'tap' || c.op === 'type')).toEqual([]);
  });

  it('a step that leaves the app out of the foreground fails', async () => {
    const { run } = fakeRun(ok(`  - id: a\n    steps: [{wait: 0.1}]\n`));
    const { client } = fakeClient((c) => (c.op === 'state' ? { state: 'runningBackground' } : {}));
    await expect(playScenes(stage(run, client))).rejects.toThrow(/not in the foreground any more \(runningBackground\)/);
  });

  it('--until stops after its step; the next scene never starts', async () => {
    const { run, record, timeline } = fakeRun(ok(`  - id: a\n    steps: [{wait: 0.1}, {wait: 0.1}]\n  - id: b\n    steps: [{wait: 0.1}]\n`), { sceneIndex: 0, stepIndex: 0 });
    const { client } = fakeClient();
    await playScenes(stage(run, client));
    expect(record.stopped_at).toEqual({ scene: 'a', step: 0, reason: 'until' });
    expect(timeline.scenes).toHaveLength(1);
  });

  it('typing: tap into the field, clear its value by deletes, chunks paced to cps, return', async () => {
    const { run } = fakeRun(ok(`  - id: a\n    steps:\n      - type: {into: {placeholder: Notes}, text: "Whole bean, Tuesday", cps: 14, clear: true, enter: true}\n`));
    const { calls, client } = fakeClient((c) => (c.op === 'tap' ? { value: 'old', placeholder: 'Notes' } : {}));
    await playScenes(stage(run, client));
    const ops = calls.map((c) => c.op);
    expect(ops[0]).toBe('tap');
    expect(calls[1]).toEqual({ op: 'key', body: { name: 'delete', times: 3 } });
    const typed = calls.filter((c) => c.op === 'type').map((c) => c.body.text);
    expect(typed.join('')).toBe('Whole bean, Tuesday');
    expect(typed[0]).toHaveLength(typingChunk(14, 19));
    expect(calls.at(-2)).toEqual({ op: 'key', body: { name: 'return' } });
  });

  it('the chunk of a typing call keeps to the pace (one call when faster than XCUITest types)', () => {
    expect(typingChunk(14, 40)).toBe(8);
    expect(typingChunk(8, 40)).toBe(3);
    expect(typingChunk(2, 40)).toBe(1);
    expect(typingChunk(40, 12)).toBe(12);
  });

  it("the status bar's time: the scenario clock's in its zone (US 12-hour), else 9:41", () => {
    expect(statusBarTime(undefined)).toBe('9:41');
    expect(statusBarTime({ epoch_ms: Date.parse('2026-11-17T14:05:00Z'), timezone: 'Europe/Paris' })).toBe('3:05');
    expect(statusBarTime({ epoch_ms: Date.parse('2026-11-17T09:41:00Z'), timezone: 'UTC' })).toBe('9:41');
  });
});
