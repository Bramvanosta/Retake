/**
 * The MCP tools against the operation catalogue (@retake/engine/contract): the tools tools/list gives are the
 * operations the catalogue says MCP serves, in the same order, and each tool's annotations agree with its kind.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE, catalogueOperation, servedNames } from '@retake/engine/contract';
import { TOOLS } from '../src/index.js';
import { kindProblem } from '../../engine/test/catalogue-rules.js';

describe('the MCP tools and the operation catalogue', () => {
  it('serves exactly the operations the catalogue gives MCP, in its order (45)', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(servedNames('mcp'));
    expect(TOOLS).toHaveLength(45);
  });

  it("each tool's annotations agree with its operation's kind", () => {
    for (const t of TOOLS) expect(kindProblem(catalogueOperation(t.name)!.kind, t.annotations), t.name).toBeUndefined();
  });

  it('kindProblem bites on each disagreement', () => {
    expect(kindProblem('read', { readOnlyHint: false })).toBeDefined();
    expect(kindProblem('write', { readOnlyHint: true })).toBeDefined();
    expect(kindProblem('destructive', { readOnlyHint: false, destructiveHint: false })).toBeDefined();
    expect(kindProblem('job', { readOnlyHint: false, destructiveHint: true })).toBeDefined();
    expect(kindProblem('runs_code', { readOnlyHint: false, destructiveHint: true })).toBeUndefined();
    expect(CATALOGUE.length).toBeGreaterThan(TOOLS.length);
  });
});
