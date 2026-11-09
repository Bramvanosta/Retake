/**
 * L5.16c (critique H1) — scaffolds never write a path into the installed app into the person's files: from an app
 * bundle, `retake sandbox init`'s sandbox.yaml and `retake components create`'s component.yaml have no
 * `# yaml-language-server: $schema=…` line at all (a path into the app breaks when it moves or updates); from a
 * repository checkout they keep today's relative path.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { SANDBOX_SCHEMA_FILE } from '@retake/core';
import { loadProject, overrideBundleInfo } from '@retake/core/io';
import type { BundleInfo } from '@retake/core/io';
import { createComponent } from '@retake/components';
import { initSandbox, schemaRef } from '../src/index.js';

/** The scaffold's writer in these tests: plain files (the engine's project store in the CLI). */
const plainWrite = async (file: string, text: string): Promise<void> => {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text);
};

const REPO = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
/** A bundle whose sealed folder holds this checkout (so the schema files lie "inside the app"). */
const APP = { root: join(REPO, 'Contents', 'Resources'), sealed: REPO, manifest: {}, paths: {} } as unknown as BundleInfo;
const dirs: string[] = [];
afterEach(() => overrideBundleInfo(undefined));
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('no $schema path into the app', () => {
  it('schemaRef: null inside an app, the relative path from a checkout', () => {
    expect(schemaRef('/Users/me/ws/projects/p/sandbox', SANDBOX_SCHEMA_FILE, APP)).toBeNull();
    expect(schemaRef(join(REPO, 'x', 'sandbox'), SANDBOX_SCHEMA_FILE, null)).toBe('../../packages/core/schema/sandbox.schema.json');
  });

  it('retake sandbox init and components create from an app: no $schema line, the files still valid', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'schema-bundle-'));
    dirs.push(ws);
    const dir = join(ws, 'projects', 'p');
    await mkdir(dir, { recursive: true });
    await writeFile(join(ws, 'retake.yaml'), 'version: 1\n');
    await writeFile(join(dir, 'project.yaml'), 'name: P\nenvironments:\n  local: {app: "http://localhost:4600"}\n');
    overrideBundleInfo(APP);
    const res = await initSandbox(await loadProject(dir), { write: plainWrite,  isFree: async () => true });
    const manifest = await readFile(res.manifest, 'utf8');
    expect(manifest).not.toContain('$schema');
    expect(manifest).not.toContain(REPO);
    expect(manifest.startsWith('# Sandbox sandbox (written by `retake sandbox init`)')).toBe(true);
    expect((await loadProject(dir)).sandboxes!.sandbox!.issues).toEqual([]);
    const created = await createComponent(ws, { write: plainWrite,  id: 'acme/my-card', kind: 'card', description: 'Ours.' });
    const yaml = await readFile(join(created.dir, 'component.yaml'), 'utf8');
    expect(yaml).not.toContain('$schema');
    expect(yaml).not.toContain(REPO);
    expect(created.issues).toEqual([]);
    // From a checkout: the line is there, relative.
    overrideBundleInfo(null);
    const again = await createComponent(ws, { write: plainWrite,  id: 'acme/other-card', kind: 'card', description: 'Ours.' });
    expect(await readFile(join(again.dir, 'component.yaml'), 'utf8')).toMatch(/^# yaml-language-server: \$schema=\.\.\/\S+component\.schema\.json$/m);
  });
});
