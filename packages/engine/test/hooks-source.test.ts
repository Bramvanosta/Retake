/**
 * A hooks file named by a client outside the CLI (selectHooks `projectFilesOnly`): `hooks/<name>.yaml` of the project,
 * its real path inside the project folder — a link out of it is refused before it is read (the containment check of
 * core path-inside.ts, as spelt on both real paths).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HooksSourceError, selectHooks } from '../src/index.js';
import { PERSON_POLICY } from '@retake/core';
import { fileFacts } from '@retake/core/io';

describe('selectHooks: a hooks file of the project only', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'retake-hooks-source-')));
  const dir = join(root, 'p');
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'outside.yaml'), '- shell: echo outside\n');
  writeFileSync(join(dir, 'hooks', 'in.yaml'), '- shell: echo inside\n');
  symlinkSync(join(root, 'outside.yaml'), join(dir, 'hooks', 'out.yaml'));
  symlinkSync(join(dir, 'hooks', 'in.yaml'), join(dir, 'hooks', 'alias.yaml'));
  const project = { dir, slug: 'p', config: { name: 'p', environments: {} } } as never;
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('refuses a link that leads out of the project, before reading it', async () => {
    const e = await selectHooks(project, 'hooks/out.yaml', undefined, { files: fileFacts(PERSON_POLICY), projectFilesOnly: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HooksSourceError);
    expect((e as HooksSourceError).message).toBe('hooks file "hooks/out.yaml" leads outside the project');
    expect((e as HooksSourceError).usage).toBe(true);
  });

  it('a file of the project, or a link to one, passes the check', async () => {
    for (const spec of ['hooks/in.yaml', 'hooks/alias.yaml']) {
      const e = await selectHooks(project, spec, undefined, { files: fileFacts(PERSON_POLICY), projectFilesOnly: true }).then(() => null, (x: unknown) => x);
      expect(e instanceof HooksSourceError ? e.message : null, spec).toBeNull();
    }
  });
});
