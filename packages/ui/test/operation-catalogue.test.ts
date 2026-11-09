/**
 * The Studio's ops against the operation catalogue (@retake/engine/contract): the allow-list (UI_OPS) is the set the
 * catalogue says the Studio serves; the MCP tools among them are the operations both serve, the Studio's own ops the
 * ones MCP does not; each op's annotations agree with its kind; the pinned arguments and own statuses are the
 * catalogue's.
 */
import { describe, expect, it } from 'vitest';
import { catalogueOperation, servedBy, servedNames, studioPins } from '@retake/engine/contract';
import { TOOLS } from '@retake/mcp';
import { OWN_OPS, UI_OPS } from '../src/index.js';
import { OP_STATUS } from '../src/server/studio.js';
import { kindProblem } from '../../engine/test/catalogue-rules.js';
import { stubTools } from './studio-tools.js';

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("the Studio's ops and the operation catalogue", () => {
  it('the allow-list is what the catalogue gives the Studio (76): the MCP tools both serve and its own ops', () => {
    expect(sorted(UI_OPS)).toEqual(sorted(servedNames('studio')));
    const mcp = new Set(TOOLS.map((t) => t.name));
    expect(sorted(UI_OPS.filter((op) => mcp.has(op)))).toEqual(sorted(servedNames('studio').filter((n) => servedBy(catalogueOperation(n)!, 'mcp'))));
    expect(sorted(OWN_OPS)).toEqual(sorted(servedNames('studio').filter((n) => !servedBy(catalogueOperation(n)!, 'mcp'))));
    expect(sorted(stubTools().keys())).toEqual(sorted(UI_OPS));
  });

  it("each op's annotations agree with its operation's kind", () => {
    for (const [name, t] of stubTools()) expect(kindProblem(catalogueOperation(name)!.kind, t.annotations), name).toBeUndefined();
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
