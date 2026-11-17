/**
 * A project's view (project_get, the Studio's project screens) of an iOS environment: its app, device type and
 * deep-link schemes — not an environment of no pages.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';

const root = mkdtempSync(join(tmpdir(), 'retake-view-ios-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the view of an iOS environment', () => {
  it('says the app, the device and the schemes; a web environment has none of it', async () => {
    const dir = join(root, 'projects', 'buyer');
    mkdirSync(join(dir, 'scenarios'), { recursive: true });
    writeFileSync(join(root, 'retake.yaml'), 'projects_dir: projects\n');
    writeFileSync(
      join(dir, 'project.yaml'),
      'name: Buyer\nenvironments:\n  web: {app: "https://app.example.com"}\n  simulator:\n    ios: {app: com.example.buyer, device: iPhone 17 Pro, schemes: [northfield]}\n',
    );
    const engine = await createEngine({ root, client: 'test', autoStartWorker: false });
    const p = await engine.projects.get('buyer');
    const sim = p.environments.find((e) => e.name === 'simulator');
    expect(sim).toMatchObject({ pages: {}, ios: { app: 'com.example.buyer', device: 'iPhone 17 Pro', schemes: ['northfield'] } });
    expect(p.environments.find((e) => e.name === 'web')?.ios).toBeUndefined();
  });
});
