/**
 * The MCP tools against the operation catalogue (@retake/engine/catalogue): the tools tools/list gives are the
 * operations the catalogue says MCP serves, in the same order, and each tool's annotations are the hints its
 * operation's facets give (hintsOf: read-only exactly for a read, destructive exactly for destructive).
 */
import { describe, expect, it } from 'vitest';
import { annotationProblem, catalogueOperation, hintsOf, servedNames } from '@retake/engine/catalogue';
import { TOOLS } from '../src/index.js';

describe('the MCP tools and the operation catalogue', () => {
  it('serves exactly the operations the catalogue gives MCP, in its order (45)', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(servedNames('mcp'));
    expect(TOOLS).toHaveLength(45);
  });

  it("each tool's read-only and destructive hints are its operation's facets'", () => {
    for (const t of TOOLS) {
      const op = catalogueOperation(t.name)!;
      expect(annotationProblem(op, t.annotations), t.name).toBeUndefined();
      expect({ readOnlyHint: t.annotations.readOnlyHint, destructiveHint: t.annotations.destructiveHint }, t.name).toEqual(hintsOf(op));
    }
    // The destructive tools, by name: what the hint warns a client of.
    expect(TOOLS.filter((t) => t.annotations.destructiveHint).map((t) => t.name)).toEqual(['project_prune', 'template_create_from_brand', 'hooks_run', 'env_reset', 'sandbox_up', 'sandbox_reset']);
  });
});
