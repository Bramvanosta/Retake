/**
 * The import-rules ratchet: the layer rules of docs/audit/target-architecture.md (R1–R7), file cycles, who builds the
 * file job queue and who calls the process-wide setters, held to the committed baseline (scripts/audit/baseline.json).
 * A new violation fails, and so does a stale baseline entry (the count only goes down, in the commit that lowers it).
 * The rules are scripts/audit/lib.mjs, shared with the audit scripts (rules.mjs, imports.mjs).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script without types
import * as lib from '../../../scripts/audit/lib.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Hit = { rule: string; file: string; spec: string };
const hits = (fileImports: Record<string, string[]>, root = ROOT): string[] => lib.ruleHits(root, fileImports).map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`);
const wiring = (rel: string, text: string): string[] => lib.wiringHits(ROOT, [{ rel, pkg: rel.split('/')[1], text, specs: [] }]).map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`);

describe('the import-rules ratchet', () => {
  it('the repository holds its baseline: no new violation, no stale entry, every group with a reason', () => {
    const entries = lib.ratchetEntries(ROOT);
    const report = lib.ratchetReport(lib.compareBaseline(entries, lib.readBaseline(ROOT)));
    expect(report, report).toBe('');
    // The baseline is written the way --write-baseline writes it (so that command only ever changes what moved).
    const baseline = lib.readBaseline(ROOT);
    expect(lib.rewriteBaseline(entries, baseline)).toEqual(baseline);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('flags each layer rule on the import that breaks it, and leaves the allowed imports alone', () => {
    expect(hits({ 'packages/core/src/a.ts': ['node:fs', 'fs/promises', 'node:path', 'zod', './b.js'] })).toEqual(['R1 packages/core/src/a.ts → node:fs', 'R1 packages/core/src/a.ts → fs/promises']);
    expect(hits({ 'packages/editor/src/a.ts': ['@retake/engine', '@retake/core'], 'packages/hooks/src/a.ts': ['@retake/cli'] })).toEqual(['R2 packages/editor/src/a.ts → @retake/engine', 'R2 packages/hooks/src/a.ts → @retake/cli']);
    expect(hits({ 'packages/ui/src/server/a.ts': ['@retake/mcp', '@retake/engine'], 'packages/cli/src/a.ts': ['@retake/mcp', '@retake/ui'] })).toEqual(['R3 packages/ui/src/server/a.ts → @retake/mcp']);
    expect(hits({ 'packages/mcp/src/a.ts': ['@retake/editor', '@retake/engine', '@retake/core'] })).toEqual(['R4 packages/mcp/src/a.ts → @retake/editor']);
    expect(hits({ 'packages/mcp/src/tools/a.ts': ['node:fs', 'node:path'], 'packages/mcp/src/a.ts': ['node:fs'], 'packages/cli/src/commands/b.ts': ['child_process'] })).toEqual(['R6 packages/mcp/src/tools/a.ts → node:fs', 'R6 packages/cli/src/commands/b.ts → child_process']);
    expect(hits({ 'packages/editor/src/plan.ts': ['remotion', 'node:fs', './timing.js'], 'packages/review/src/checks.ts': ['react'], 'packages/editor/src/render/a.ts': ['remotion'] })).toEqual(['R7 packages/editor/src/plan.ts → remotion', 'R7 packages/editor/src/plan.ts → node:fs', 'R7 packages/review/src/checks.ts → react']);
  });

  it('allows type-only imports from other packages in the Studio front end, not value imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'retake-import-rules-'));
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put('packages/ui/src/app/types.ts', "import type { Step } from '@retake/core';\n");
    put('packages/ui/src/app/value.ts', "import { parseScenario } from '@retake/core';\n");
    try {
      expect(hits({ 'packages/ui/src/app/types.ts': ['@retake/core'], 'packages/ui/src/app/value.ts': ['@retake/core'] }, root)).toEqual(['R5 packages/ui/src/app/value.ts → @retake/core']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds a file cycle and names it by its first file', () => {
    const cycles = lib.fileCycles({ 'packages/x/src/b.ts': ['./a.js'], 'packages/x/src/a.ts': ['./b.js'], 'packages/x/src/c.ts': ['./a.js', './d/index.js'], 'packages/x/src/d/index.ts': [] });
    expect(cycles).toEqual([['packages/x/src/a.ts', 'packages/x/src/b.ts']]);
  });

  it('flags the file job queue built outside the engine, under its name, an alias or as a base class', () => {
    expect(wiring('packages/ui/src/server/a.ts', "import { FileJobQueue } from '@retake/engine';\nconst q = new FileJobQueue(root);")).toEqual(['queue packages/ui/src/server/a.ts → new FileJobQueue']);
    expect(wiring('packages/cli/src/a.ts', "import { FileJobQueue as Q } from '@retake/engine';\nconst q = new Q(root);")).toEqual(['queue packages/cli/src/a.ts → new FileJobQueue']);
    expect(wiring('packages/mcp/src/a.ts', "import * as e from '@retake/engine';\nconst q = new e.FileJobQueue(root);\nclass Mine extends e.FileJobQueue {}")).toEqual(['queue packages/mcp/src/a.ts → new FileJobQueue', 'queue packages/mcp/src/a.ts → extends FileJobQueue']);
    expect(wiring('packages/engine/src/jobs/a.ts', 'const q = new FileJobQueue(root);')).toEqual([]);
    expect(wiring('packages/ui/src/server/b.ts', "import type { FileJobQueue } from '@retake/engine';\nlet q: FileJobQueue;")).toEqual([]);
  });

  it('flags a process-wide setter used outside the workspace module, called or passed on, and not its declaration', () => {
    expect(wiring('packages/cli/src/a.ts', "import { useAgentPolicy } from '@retake/core';\nuseAgentPolicy(null);")).toEqual(['setter packages/cli/src/a.ts → useAgentPolicy']);
    expect(wiring('packages/ui/src/server/a.ts', "import * as core from '@retake/core';\ncore.useWorkspaceFfmpeg('x');")).toEqual(['setter packages/ui/src/server/a.ts → useWorkspaceFfmpeg']);
    expect(wiring('packages/mcp/src/a.ts', "import { useWorkspaceRender as set } from '@retake/core';\nconst f = set;\nf(undefined);")).toEqual(['setter packages/mcp/src/a.ts → useWorkspaceRender']);
    expect(wiring('packages/engine/src/workspace.ts', "import { useAgentPolicy } from '@retake/core';\nuseAgentPolicy(null);")).toEqual([]);
    expect(wiring('packages/core/src/agent-policy.ts', 'export function useAgentPolicy(folders: string[] | null): void {}')).toEqual([]);
    expect(wiring('packages/core/src/index.ts', "export { useAgentPolicy } from './agent-policy.js';")).toEqual([]);
  });

  it('fails on a new entry, a stale entry, a group without a reason, and says how to update the baseline', () => {
    const baseline = { groups: [{ rule: 'R1', reason: 'Loaders.', entries: ['packages/core/src/a.ts → node:fs', 'packages/core/src/gone.ts → node:fs'] }, { rule: 'R6', reason: '', entries: ['packages/cli/src/commands/a.ts → node:fs'] }] };
    const now = ['R1 packages/core/src/a.ts → node:fs', 'R1 packages/core/src/new.ts → node:os', 'R6 packages/cli/src/commands/a.ts → node:fs'];
    const cmp = lib.compareBaseline(now, baseline);
    expect(cmp.added).toEqual(['R1 packages/core/src/new.ts → node:os']);
    expect(cmp.stale).toEqual(['R1 packages/core/src/gone.ts → node:fs']);
    expect(cmp.unexplained).toEqual(['R6: packages/cli/src/commands/a.ts → node:fs']);
    const report = lib.ratchetReport(cmp);
    expect(report).toContain('New violations');
    expect(report).toContain('Stale baseline entries');
    expect(report).toContain('node scripts/audit/rules.mjs . --write-baseline');
    expect(lib.ratchetReport(lib.compareBaseline(['R1 packages/core/src/a.ts → node:fs'], { groups: [{ rule: 'R1', reason: 'x', entries: ['packages/core/src/a.ts → node:fs'] }] }))).toBe('');
    expect(lib.compareBaseline([], { groups: [{ rule: 'R9', reason: 'x', entries: ['a → b'] }] }).misfiled).toEqual(['R9 a → b']);
  });

  it('rewrites the baseline keeping reasons, dropping stale entries and grouping new ones to explain', () => {
    const baseline = { about: 'a', groups: [{ rule: 'R1', reason: 'Loaders.', entries: ['packages/core/src/a.ts → node:fs', 'packages/core/src/gone.ts → node:fs'] }, { rule: 'R4', reason: 'Gone.', entries: ['packages/cli/src/x.ts → @retake/editor'] }] };
    const next = lib.rewriteBaseline(['R1 packages/core/src/a.ts → node:fs', 'R1 packages/core/src/new.ts → node:os', 'queue packages/ui/src/a.ts → new FileJobQueue'], baseline);
    expect(next).toEqual({
      about: 'a',
      groups: [
        { rule: 'R1', reason: 'Loaders.', entries: ['packages/core/src/a.ts → node:fs'] },
        { rule: 'R1', reason: '', entries: ['packages/core/src/new.ts → node:os'] },
        { rule: 'queue', reason: '', entries: ['packages/ui/src/a.ts → new FileJobQueue'] },
      ],
    });
  });
});
