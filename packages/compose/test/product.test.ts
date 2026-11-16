/**
 * The product's composition: the engine loads no adapter package by itself — a process that has not bound the product
 * is refused by name — and the composition package binds the package adapters, the editor's and the components'
 * modules and the worker entry; the built engine's package depends on core and the domain entries' packages only.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bindProduct, productPorts } from '@retake/compose';
import { bindProduct as bindEngineProduct, enginePorts, productBound, type EnginePorts } from '@retake/engine/composition';

const REPO = join(import.meta.dirname, '..', '..', '..');
const dist = (pkg: string, file: string) => pathToFileURL(join(REPO, 'packages', pkg, 'dist', file)).href;

/** Run an ES module script in a process of its own (no test setup: nothing bound). */
function run(script: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: REPO, env: { ...process.env, RETAKE_DISK_WARN: 'off' } });
}

describe('the product bound into the engine', () => {
  it('an engine with no product bound refuses its package ports by name; every port handed needs none', () => {
    const script = `const e = await import(${JSON.stringify(dist('engine', 'composition.js'))});
const out = {};
try { e.enginePorts(); out.ports = 'made'; } catch (x) { out.ports = [x.name, x.kind, x.message]; }
const own = { hooks: {}, reviewer: {}, capture: {}, sandboxes: {}, renderer: {}, registries: {} };
out.handed = Object.keys(e.enginePorts(own)).length;
const lazy = await import(${JSON.stringify(dist('engine', 'lazy.js'))});
try { await lazy.editor(); out.editor = 'loaded'; } catch (x) { out.editor = x.message; }
console.log(JSON.stringify(out));`;
    const r = run(script);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { ports: string[]; handed: number; editor: string };
    expect(out.ports[0]).toBe('EngineError');
    expect(out.ports[2]).toMatch(/no product is bound .*@retake\/compose/);
    expect(out.handed).toBe(15);
    expect(out.editor).toMatch(/no adapter modules are bound.*@retake\/compose/);
  });

  it("binding the product gives the package ports, the editor's module and the worker entry of the composition package", () => {
    const script = `const c = await import(${JSON.stringify(dist('compose', 'index.js'))});
const e = await import(${JSON.stringify(dist('engine', 'composition.js'))});
const spawn = await import(${JSON.stringify(dist('engine', 'jobs/spawn.js'))});
const p = c.productPorts();
const lazy = await import(${JSON.stringify(dist('engine', 'lazy.js'))});
const ed = await lazy.editor();
console.log(JSON.stringify({ ports: Object.keys(p).sort(), same: Object.keys(e.enginePorts()).length, planRun: typeof ed.planRun, worker: spawn.workerCommand('/w').args }));`;
    const r = run(script);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { ports: string[]; same: number; planRun: string; worker: string[] };
    expect(out.ports).toEqual(['capture', 'clock', 'env', 'fontRegistry', 'hooks', 'hosts', 'outputs', 'queues', 'reads', 'registries', 'renderer', 'reviewer', 'sandboxes', 'secrets', 'stores']);
    expect(out.same).toBe(15);
    expect(out.planRun).toBe('function');
    expect(out.worker).toContain(join(REPO, 'packages', 'compose', 'dist', 'worker-main.js'));
  });

  it('productPorts keeps the ports handed and makes the others, the sandboxes on the hook runner of the bag', () => {
    const hooks = { marker: 'hooks' } as unknown as EnginePorts['hooks'];
    const p = productPorts({ hooks });
    expect(p.hooks).toBe(hooks);
    expect([typeof p.renderer.video, typeof p.capture.run, typeof p.reviewer.review, typeof p.sandboxes.open, typeof p.registries.load]).toEqual(Array(5).fill('function'));
    // The engine's own enginePorts, once bound, gives the same kind of bag.
    expect(Object.keys(enginePorts()).sort()).toEqual(Object.keys(p).sort());
  });

  it('binding the same product again is a no-op; binding another once one is bound is refused by name', () => {
    expect(() => bindProduct()).not.toThrow();
    expect(() => bindProduct()).not.toThrow();
    const other = { modules: { editor: async () => ({}) as never, components: async () => ({}) as never }, adapters: () => ({}) as never, workerEntry: '/other/worker-main.js' };
    expect(() => bindEngineProduct(other)).toThrow(/another product is bound in this process already/);
    // The bound product is still the composition package's.
    expect(productBound()).toBe(true);
    expect(Object.keys(productPorts()).length).toBe(15);
  });

  it('productPorts binds only when no product is bound: a product bound first stays, and the composition package then refuses to bind its own', () => {
    const script = `const e = await import(${JSON.stringify(dist('engine', 'composition.js'))});
const c = await import(${JSON.stringify(dist('compose', 'index.js'))});
const spawn = await import(${JSON.stringify(dist('engine', 'jobs/spawn.js'))});
const port = () => ({});
const own = { modules: { editor: async () => ({}), components: async () => ({}) }, adapters: () => ({ hooks: { own: 1 }, reviewer: port(), capture: port(), sandboxes: port(), renderer: port(), registries: port() }), workerEntry: '/own/worker-main.js' };
e.bindProduct(own);
const out = { hooks: c.productPorts().hooks, worker: spawn.workerCommand('/w').args };
try { c.bindProduct(); out.bind = 'bound'; } catch (x) { out.bind = x.message; }
console.log(JSON.stringify(out));`;
    const r = run(script);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { hooks: unknown; worker: string[]; bind: string };
    expect(out.hooks).toEqual({ own: 1 });
    expect(out.worker).toContain('/own/worker-main.js');
    expect(out.bind).toMatch(/another product is bound in this process already/);
  });

  it('createEngine with no product bound refuses at its creation: a package port not handed, or a worker it would start', () => {
    const script = `const e = await import(${JSON.stringify(dist('engine', 'index.js'))});
const port = () => ({});
const all = { hooks: port(), reviewer: port(), capture: port(), sandboxes: port(), renderer: port(), registries: port() };
const out = [];
for (const o of [{ autoStartWorker: false }, { ports: all }]) {
  try { await e.createEngine({ root: '/nowhere-retake', client: 'cli', ...o }); out.push('made'); } catch (x) { out.push(x.message); }
}
console.log(JSON.stringify(out));`;
    const r = run(script);
    expect(r.status, r.stderr).toBe(0);
    const [missing, worker] = JSON.parse(r.stdout) as string[];
    expect(missing).toMatch(/the engine's ports: no product is bound/);
    expect(worker).toMatch(/an engine that starts its worker: no product is bound/);
  });

  it("the engine's package depends on core and the domain entries' packages; the shells depend on the composition package", () => {
    const deps = (pkg: string) => Object.keys((JSON.parse(readFileSync(join(REPO, 'packages', pkg, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies);
    expect(deps('engine').filter((d) => d.startsWith('@retake/'))).toEqual([
      '@retake/components',
      '@retake/core',
      '@retake/editor',
      '@retake/hooks',
      '@retake/review',
      '@retake/runner-web',
      '@retake/sandbox',
    ]);
    expect(deps('engine')).not.toContain('@retake/compose');
    for (const shell of ['cli', 'mcp', 'ui']) expect(deps(shell), shell).toContain('@retake/compose');
  });
});
