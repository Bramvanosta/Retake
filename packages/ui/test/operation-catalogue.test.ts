/**
 * The Studio's ops against the operation catalogue (@retake/engine/catalogue): the allow-list (UI_OPS) is what the
 * catalogue says the Studio serves, in its order; the MCP tools among them are the operations both serve, the Studio's
 * own ops the ones MCP does not; each op's read-only and destructive hints are its facets'; the pinned arguments and
 * own statuses are the catalogue's.
 */
import { describe, expect, it } from 'vitest';
import { annotationProblem, catalogueOperation, hintsOf, servedBy, servedNames, studioPins } from '@retake/engine/catalogue';
import { TOOLS } from '@retake/mcp';
import { OWN_OPS, UI_OPS } from '../src/index.js';
import { OP_STATUS } from '../src/server/studio.js';
import { stubTools } from './studio-tools.js';

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("the Studio's ops and the operation catalogue", () => {
  it('the allow-list is what the catalogue gives the Studio (76), in its order: the MCP tools both serve and its own ops', () => {
    expect([...UI_OPS]).toEqual(servedNames('studio'));
    expect(UI_OPS).toHaveLength(76);
    expect(Object.isFrozen(UI_OPS)).toBe(true);
    const mcp = new Set<string>(TOOLS.map((t) => t.name));
    expect(sorted(UI_OPS.filter((op) => mcp.has(op)))).toEqual(sorted(servedNames('studio').filter((n) => servedBy(catalogueOperation(n)!, 'mcp'))));
    expect(sorted(OWN_OPS)).toEqual(sorted(servedNames('studio').filter((n) => !servedBy(catalogueOperation(n)!, 'mcp'))));
    expect(sorted(stubTools().keys())).toEqual(sorted(UI_OPS));
  });

  it("each op's read-only and destructive hints are its operation's facets'", () => {
    for (const [name, t] of stubTools()) {
      const op = catalogueOperation(name)!;
      expect(annotationProblem(op, t.annotations), name).toBeUndefined();
      expect({ readOnlyHint: t.annotations.readOnlyHint, destructiveHint: t.annotations.destructiveHint }, name).toEqual(hintsOf(op));
    }
  });

  it("the pinned arguments are the catalogue's, applied to the tool the Studio serves", () => {
    const tools = stubTools();
    const narrowed = UI_OPS.filter((op) => studioPins(op).length);
    expect(narrowed).toEqual(['run_status', 'auth_login']);
    const status = tools.get('run_status')!.input;
    expect(status.safeParse({ project: 'p', run_id: '20261017-142233-quote', wait_s: 25 }).success).toBe(false);
    expect(status.safeParse({ project: 'p', run_id: '20261017-142233-quote' }).success).toBe(true);
    expect(status.safeParse({ project: 'p', run_id: '20261017-142233-quote', wait_s: 0 }).success).toBe(true);
    const login = tools.get('auth_login')!.input;
    expect(login.parse({ project: 'p' })).toMatchObject({ mode: 'headed', wait_s: 0 });
    expect(login.safeParse({ project: 'p', mode: 'auto' }).success).toBe(false);
    // The MCP tool itself keeps its arguments.
    expect(TOOLS.find((t) => t.name === 'auth_login')!.input.safeParse({ project: 'p', mode: 'auto' }).success).toBe(true);
  });

  it("the ops' own statuses are the catalogue's", () => {
    expect(OP_STATUS).toEqual({ render_frame: { busy: 429 } });
  });
});
