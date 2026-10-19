import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPONENT_KINDS } from '@demo-studio/core';
import {
  ALLOWED_IMPORTS,
  KIT_MODULE,
  formatComponentIssues,
  scaffoldDir,
  scanSource,
  stripComments,
  validateComponent,
  validateComponentDir,
} from '@demo-studio/components';
import { CARD_TSX, cardManifest, tempDir, writeFiles } from './helpers.js';

let ws: { dir: string; cleanup: () => Promise<void> };

beforeAll(async () => {
  ws = await tempDir();
});

afterAll(async () => {
  await ws.cleanup();
});

/** Write components/<id>/ with a card manifest and the given index.tsx (+ extra files), then validate it. */
async function check(id: string, tsx: string, extra: Record<string, string> = {}, manifest = cardManifest(id)) {
  const files: Record<string, string> = { [`components/${id}/component.yaml`]: manifest, [`components/${id}/index.tsx`]: tsx };
  for (const [k, v] of Object.entries(extra)) files[`components/${id}/${k}`] = v;
  await writeFiles(ws.dir, files);
  const issues = await validateComponent(join(ws.dir, 'components', id));
  return { issues, text: formatComponentIssues(issues) };
}

describe('validateComponent (R-REG-05..09, R-CMP-06)', () => {
  it('every scaffold is a valid component as-is: no error, no warning', async () => {
    for (const kind of COMPONENT_KINDS) {
      const v = await validateComponentDir(scaffoldDir(kind));
      expect(formatComponentIssues(v.issues), kind).toBe('');
      expect(v.ok).toBe(true);
      expect(v.manifest?.kind).toBe(kind);
      expect(v.manifest?.id).toBe(`scaffolds/${kind}`);
    }
  });

  it('a valid workspace component compiles (react, remotion and the kit only)', async () => {
    const r = await check('acme/ok-card', CARD_TSX);
    expect(r.text).toBe('');
  });

  it('renderer primitives imported from the kit compile; a misspelt one is named with the kit export (L3.7)', async () => {
    const tsx = `import { AbsoluteFill, Img, Sequence, random, useCurrentFrame, useVideoConfig } from '${KIT_MODULE}';
export default function X() {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <AbsoluteFill><Sequence from={fps}><Img src="x.png" style={{ opacity: random(f) }} /></Sequence></AbsoluteFill>;
}
`;
    expect((await check('acme/kit-renderer', tsx)).text).toBe('');
    const typo = `import { useCurrentFrme } from '${KIT_MODULE}';
export default function X() { return <div>{useCurrentFrme()}</div>; }
`;
    expect((await check('acme/kit-typo', typo)).text).toBe(
      `index.tsx:1:10 error: "${KIT_MODULE}" has no export named "useCurrentFrme" (did you mean "useCurrentFrame"?)`,
    );
  });

  it('reports a missing folder, manifest or entry file', async () => {
    expect(formatComponentIssues(await validateComponent(join(ws.dir, 'components/acme/nothing')))).toMatch(/error: component folder not found/);
    await writeFiles(ws.dir, { 'components/acme/empty/README.md': '' });
    expect(formatComponentIssues(await validateComponent(join(ws.dir, 'components/acme/empty')))).toBe(
      'component.yaml error: missing component.yaml (the manifest of the component)',
    );
    await writeFiles(ws.dir, { 'components/acme/no-entry/component.yaml': cardManifest('acme/no-entry') });
    expect(formatComponentIssues(await validateComponent(join(ws.dir, 'components/acme/no-entry')))).toBe(
      'component.yaml:1:1 error: entry file "index.tsx" not found in the component folder',
    );
    await writeFiles(ws.dir, { 'components/acme/other-entry/component.yaml': cardManifest('acme/other-entry', 'entry: src/main.tsx') });
    expect(formatComponentIssues(await validateComponent(join(ws.dir, 'components/acme/other-entry')))).toBe(
      'component.yaml:17:1 error entry: entry file "src/main.tsx" not found in the component folder',
    );
  });

  it('reports manifest errors with positions and an id that does not match the folder (R-REG-05)', async () => {
    const r = await check('acme/mismatch', CARD_TSX, {}, cardManifest('acme/other').replace('version: 1.0.0', 'version: v1'));
    expect(r.text).toMatch(/^component\.yaml:1:5 error id: id "acme\/other" does not match the folder path "acme\/mismatch"/m);
    expect(r.text).toMatch(/^component\.yaml:2:10 error version: version must be a semantic version/m);
    const folder = await validateComponent(join(ws.dir, 'components/acme/mismatch'), { folderId: false });
    expect(formatComponentIssues(folder)).not.toMatch(/folder path/);
  });

  it('reports syntax errors of the entry with positions (R-REG-09)', async () => {
    const r = await check('acme/syntax', 'export default function X() {\n  return <div>{1 + }</div>;\n}\n');
    expect(r.text).toBe('index.tsx:2:20 error: Unexpected "}"');
  });

  it('allows only react, remotion and the kit (+ own files), naming every other import (R-CMP-06)', async () => {
    const tsx = `import { useCurrentFrame } from 'remotion';
import { readFileSync } from 'node:fs';
import confetti from 'canvas-confetti';
import { fadeIn } from '${KIT_MODULE}';
import { helper } from './parts/helper';
import data from './data.json';
import shared from '../shared/x';
import logo from './logo.png';
import { unusedThing } from 'left-pad';

export default function X() {
  const f = useCurrentFrame();
  readFileSync('x');
  confetti();
  return <div style={{ opacity: fadeIn(f, 30) }}>{helper(data.n)}{String(shared)}{logo}</div>;
}
`;
    const r = await check('acme/imports', tsx, {
      'parts/helper.ts': 'export function helper(n: number): string { return String(n); }\n',
      'data.json': '{"n": 1}\n',
      'logo.png': 'not really a png',
    });
    expect(r.text).toBe(
      [
        `index.tsx:2:30 error: import "node:fs" is not allowed: a component may import only react, remotion and ${KIT_MODULE}`,
        `index.tsx:3:22 error: import "canvas-confetti" is not allowed: a component may import only react, remotion and ${KIT_MODULE}`,
        `index.tsx:7:20 error: import "../shared/x" leaves the component folder: a component may only import its own files, react, remotion and ${KIT_MODULE}`,
        'index.tsx:8:18 error: import "./logo.png": only code files can be imported (pass images and fonts through slots and the theme)',
        `index.tsx:9:29 error: import "left-pad" is not allowed: a component may import only react, remotion and ${KIT_MODULE}`,
      ].join('\n'),
    );
    expect(ALLOWED_IMPORTS).toEqual(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'remotion', KIT_MODULE]);
  });

  it('names a misspelt import of remotion, react or the kit with a suggestion', async () => {
    const tsx = `import { useCurrentFrme } from 'remotion';
import { useMemmo } from 'react';
import { fitTxt } from '${KIT_MODULE}';
export default function X() {
  const f = useCurrentFrme();
  const v = useMemmo(() => fitTxt(), []);
  return <div>{f}{String(v)}</div>;
}
`;
    const r = await check('acme/exports', tsx);
    expect(r.text).toBe(
      [
        'index.tsx:1:10 error: "remotion" has no export named "useCurrentFrme" (did you mean "useCurrentFrame"?)',
        'index.tsx:2:10 error: "react" has no export named "useMemmo" (did you mean "useMemo"?)',
        `index.tsx:3:10 error: "${KIT_MODULE}" has no export named "fitTxt" (did you mean "fitText"?)`,
      ].join('\n'),
    );
  });

  it('rejects non-deterministic and networked APIs, ignoring comments (R-CMP-06)', async () => {
    const tsx = `// Math.random() and fetch() in a comment are fine
import { random, useCurrentFrame } from 'remotion';
/* Date.now() */
export default function X() {
  const f = useCurrentFrame();
  const a = Math.random();
  const b = Date.now() + new Date().getTime();
  fetch('https://example.com/data.json');
  setTimeout(() => {}, 10);
  return <div>{f + a + b + random('seed')}</div>;
}
`;
    const r = await check('acme/nondeterministic', tsx);
    expect(r.text).toBe(
      [
        'index.tsx:6:13 error: Math.random() is not deterministic: use random(seed) from the kit',
        'index.tsx:7:13 error: Date.now() is not deterministic: derive time from useCurrentFrame() / fps',
        'index.tsx:7:26 error: new Date() is not deterministic: derive time from useCurrentFrame() / fps',
        'index.tsx:8:3 error: components must not use the network (fetch): take data from slots, params and the theme',
        'index.tsx:9:3 warning: timers do not follow the rendered frame: animate from useCurrentFrame() instead',
      ].join('\n'),
    );
  });

  it('random() without a seed or with null (Math.random in disguise) is refused; a seeded or member random is not', async () => {
    const tsx = `import { random, useCurrentFrame } from '${KIT_MODULE}';
const rng = { random: () => 0.5 };
export default function X() {
  const f = useCurrentFrame();
  const a = random(null) + random( undefined ) + random();
  return <div>{f + a + random(f) + random('seed') + rng.random()}</div>;
}
`;
    const r = await check('acme/unseeded', tsx);
    expect(r.text).toBe(
      [
        'index.tsx:5:13 error: random() needs a seed: random(null) is Math.random(); pass a number or a string',
        'index.tsx:5:28 error: random() needs a seed: random(null) is Math.random(); pass a number or a string',
        'index.tsx:5:50 error: random() needs a seed: random(null) is Math.random(); pass a number or a string',
      ].join('\n'),
    );
  });

  it('scans the component own files too, not only the entry', async () => {
    const r = await check('acme/helper-random', "import { jitter } from './jitter';\nexport default function X() { return <div>{jitter()}</div>; }\n", {
      'jitter.ts': 'export const jitter = () => Math.random();\n',
    });
    expect(r.text).toBe('jitter.ts:1:29 error: Math.random() is not deterministic: use random(seed) from the kit');
  });

  it('a component folder reached through a symbolic link (macOS: /var → /private/var) keeps its own imports inside', async () => {
    await check('acme/linked', "import { jitter } from './jitter';\nexport default function X() { return <div>{jitter()}</div>; }\n", {
      'jitter.ts': 'export const jitter = () => Math.random();\n',
    });
    await symlink(join(ws.dir, 'components'), join(ws.dir, 'linked-components'));
    const issues = await validateComponent(join(ws.dir, 'linked-components', 'acme', 'linked'), { folderId: 'acme/linked' });
    expect(formatComponentIssues(issues)).toBe('jitter.ts:1:29 error: Math.random() is not deterministic: use random(seed) from the kit');
  });

  it('layout components must declare geometry (R-CMP-11)', async () => {
    const manifest = 'id: acme/frame\nversion: 1.0.0\nkind: layout\nname: Frame\ndescription: A frame.\n';
    const r = await check('acme/frame', 'export default function X() { return null; }\n', {}, manifest);
    expect(r.text).toMatch(/^component\.yaml:3:7 error: a layout component must declare "geometry"/);
  });
});

describe('source scanning helpers', () => {
  it('stripComments keeps positions and strings', () => {
    const src = "const a = 'http://x'; // Math.random()\n/* fetch(\n */ const b = 1;";
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out).toContain("'http://x'");
    expect(out).not.toContain('Math.random');
    expect(out.split('\n')[2]).toBe('    const b = 1;');
    expect(scanSource(src, 'x.ts')).toEqual([]);
  });
});
