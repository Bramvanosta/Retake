/**
 * R-SBX-08: `sandbox_init` through the engine (the MCP tool's operation): Retake's own
 * docker-compose scaffold and the `sandboxes.<env>` line of project.yaml — the rest of project.yaml (its comments) kept,
 * never over an existing sandbox or file (no force: the user decides about their files), an environment's name refused.
 * Its answer names the line it wrote and warns that sandbox_up pulls images; nothing is started.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scratchHome } from '@retake/test-support/home';
import { createEngine } from '../src/index.js';
import type { Engine } from '../src/index.js';
import { sandboxInit } from '../src/operations/sandbox.js';
import { initSandbox } from '@retake/sandbox';
import { loadProject } from '@retake/core/io';
import { diskProjectStores, fileWriter, personScope } from '../src/store/project-store.js';
import { enginePorts } from '../src/ports.js';

let root: string;
let home: string;
let engine: Engine;
const retakeHome = scratchHome();
const PROJECT_YAML = ['# Acme demo — written by hand', 'name: Acme Demo', 'environments:', '  # the local copy', '  local: {app: "http://localhost:4529"}', ''].join('\n');
const projectDir = () => join(root, 'projects', 'acme');

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'retake-sandbox-init-op-home-'));
  retakeHome.use(home);
});
afterAll(async () => {
  retakeHome.restore();
  await rm(home, { recursive: true, force: true });
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-sandbox-init-op-'));
  await writeFile(join(root, 'retake.yaml'), 'version: 1\nprojects_dir: projects\n');
  await mkdir(projectDir(), { recursive: true });
  await writeFile(join(projectDir(), 'project.yaml'), PROJECT_YAML);
  engine = await createEngine({ root, client: 'mcp', autoStartWorker: false });
}, 60_000);
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (input: { project: string; env?: string }) => sandboxInit.run(input as never, { engine } as never);

describe('sandbox_init through the engine', () => {
  it('writes the scaffold and the sandboxes entry (comments of project.yaml kept), names that line and the image pull; nothing started', async () => {
    const out = await run({ project: 'acme' });
    const after = await readFile(join(projectDir(), 'project.yaml'), 'utf8');
    expect(after.startsWith(PROJECT_YAML)).toBe(true);
    expect(after.slice(PROJECT_YAML.length)).toBe('sandboxes:\n  sandbox: sandbox/sandbox.yaml\n');
    for (const f of ['sandbox.yaml', 'compose.yaml', 'README.md', 'seed/01-demo-data.sql', 'app/index.html']) expect(existsSync(join(projectDir(), 'sandbox', f)), f).toBe(true);
    expect(out.data).toMatchObject({ project: 'acme', env: 'sandbox', dir: 'sandbox', manifest: 'sandbox/sandbox.yaml', project_yaml: { action: 'added', entry: 'sandboxes.sandbox: sandbox/sandbox.yaml' }, is_default: true, warnings: [] });
    expect(out.summary).toContain('project.yaml: added sandboxes.sandbox: sandbox/sandbox.yaml (nothing else changed)');
    expect(out.summary).toMatch(/sandbox_up \{project: "acme"\} then pulls the compose file's images \(postgres, mailpit, busybox: a download\) — ask the user first/);
    expect(out.summary).toMatch(/propose the text in chat, the files are theirs/);
    // A second sandbox gets its own folder and is not the default.
    const demo = await run({ project: 'acme', env: 'demo' });
    expect(demo.data).toMatchObject({ env: 'demo', dir: 'sandbox/demo', is_default: false });
    expect(demo.summary).toMatch(/sandbox_up \{project: "acme", env: "demo"\}/);
  });

  it('never over an existing sandbox or file: refused, the file and project.yaml left as they are, and no --force offered', async () => {
    await mkdir(join(projectDir(), 'sandbox'), { recursive: true });
    await writeFile(join(projectDir(), 'sandbox', 'compose.yaml'), 'services: {mine: {image: busybox}}\n');
    const e = await run({ project: 'acme' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'conflict' });
    expect((e as Error).message).toBe(
      'sandbox/compose.yaml already exists: sandbox_init never writes over a file — the user moves it away, or runs retake sandbox init with --force in their terminal, or give the sandbox another name (env)',
    );
    expect(await readFile(join(projectDir(), 'sandbox', 'compose.yaml'), 'utf8')).toBe('services: {mine: {image: busybox}}\n');
    expect(await readFile(join(projectDir(), 'project.yaml'), 'utf8')).toBe(PROJECT_YAML);
    // A sandbox that exists: refused the same way.
    await run({ project: 'acme', env: 'demo' });
    await expect(run({ project: 'acme', env: 'demo' })).rejects.toThrow(/sandbox demo already exists .*sandbox_init never writes over a file/);
  });

  it('an env taken by environments, or not a name, is refused', async () => {
    await expect(run({ project: 'acme', env: 'local' })).rejects.toMatchObject({ code: 'conflict', message: 'environment local already exists in project.yaml: give the sandbox another name (env)' });
    await expect(engine.sandbox.init('acme', '../x')).rejects.toMatchObject({ code: 'invalid' });
    // A name environments allow but a sandbox scaffold cannot use: an invalid argument, not a conflict.
    await expect(engine.sandbox.init('acme', 'Demo')).rejects.toMatchObject({ code: 'invalid', message: '"Demo" cannot name an environment: lower-case letters, digits, "-" and "_"' });
    expect(existsSync(join(projectDir(), 'sandbox'))).toBe(false);
  });

  it('create-only for real: a file that appears after the check is never overwritten (the scaffold writes with no file expected)', async () => {
    const project = await loadProject(projectDir());
    const store = diskProjectStores.of(project, personScope(root, enginePorts()));
    const write = fileWriter(store, 'sandbox');
    const late = join(projectDir(), 'sandbox', 'compose.yaml');
    // The person's compose.yaml lands between the existence check and the write.
    const racing = async (file: string, text: string, previous?: string | null) => {
      if (file === late) {
        await mkdir(join(projectDir(), 'sandbox'), { recursive: true });
        await writeFile(late, 'services: {mine: {image: busybox}}\n');
      }
      return write(file, text, previous);
    };
    await expect(initSandbox(project, { isFree: async () => true, write: racing })).rejects.toThrow();
    expect(await readFile(late, 'utf8')).toBe('services: {mine: {image: busybox}}\n');
  });
});
