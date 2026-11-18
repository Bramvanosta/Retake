/**
 * One call of an operation, SDK-free: what every shell runs an operation through — the MCP protocol layer
 * (`protocolTool`, shell `mcp`) and the Studio's HTTP API (`POST /v1/call/<op>`, shell `studio`) — so that who may call
 * it, the parse, the caller rules and the errors stay one. Never throws: every failure comes back as an EngineError.
 */
import type { z } from 'zod';
import { opChain } from '../admission.js';
import type { OpChain } from '../admission.js';
import type { Approver } from '../approvals.js';
import { catalogueOperation, servedBy } from '../catalogue.js';
import type { Shell } from '../catalogue.js';
import type { Engine } from '../engine.js';
import { EngineError, toEngineError } from '../errors.js';
import { untrustedOperationRefusal } from '../project-archive/trust.js';
import { argumentProblems } from './define.js';
import type { Progress, ToolCallOutcome, ToolContext, ToolDef } from './define.js';

/** How a shell calls: who it is, the call's cancel, and (MCP) its progress notifications and approver. */
export interface InvokeOptions {
  shell: Shell;
  /**
   * The folder the shell's process was started in (engine_info's `started_in`): the shell reads it, an operation never.
   */
  startedIn: string;
  /** Aborted when the client cancels the call: it ends a wait, never the job. */
  signal: AbortSignal;
  progress?: (p: Progress) => void;
  approver?: Approver;
}

/** The chains of the operations that declare `serialize`, one per engine (the Studio holds one engine per server). */
const chains = new WeakMap<Engine, OpChain>();

/**
 * The engine's chain of operation calls: the calls of one key run one at a time on this engine, in order (a
 * double click, two tabs: the second finds the first's result — a new hash, its 409). invoke runs a `serialize`
 * operation through it.
 */
export function operationChain(engine: Engine): OpChain {
  let c = chains.get(engine);
  if (!c) chains.set(engine, (c = opChain()));
  return c;
}

/** Any thrown value as an EngineError, and never a throw of its own (a getter of an error's members may throw too). */
function failure(e: unknown): EngineError {
  try {
    return toEngineError(e);
  } catch {
    return new EngineError('internal', 'the operation failed with an error that cannot be read');
  }
}

/** The zod parse, its problems named per argument: invoke's words. */
function parsed<S extends z.ZodType>(t: ToolDef<S, object>, args: unknown): { ok: true; data: z.output<S> } | { ok: false; error: EngineError } {
  const r = t.input.safeParse(args);
  if (r.success) return { ok: true, data: r.data };
  const problems = argumentProblems(r.error);
  return { ok: false, error: new EngineError('invalid', `invalid arguments for ${t.name}:\n${problems.join('\n')}`, { details: { arguments: problems } }) };
}

/**
 * One call of `op` by `shell`, in order: (1) the catalogue serves it in that shell, else `not_found` — a second line
 * behind each shell's own list (MCP's TOOLS, the Studio's 404), which keep their words; (2) the parse (problems named
 * per argument); (3) the operation's caller rules (`callers`) with the engine's caller, then the refusal of an
 * operation an imported project not trusted may not be the target of (project-archive/trust.ts); (4) the handler — after the
 * earlier calls of its key when it declares `serialize` (operationChain); (5) any error typed (toEngineError).
 * `engine` is the engine or a getter of it (a getter that fails is an error, not a throw).
 * Admission is not checked here: it stays inside the submits (the run rule is checked again at reserve).
 */
export async function invoke<D extends object>(op: ToolDef<z.ZodType, D>, engine: Engine | (() => Promise<Engine>), args: unknown, o: InvokeOptions): Promise<ToolCallOutcome<D>> {
  try {
    const entry = catalogueOperation(op.name);
    if (!entry || !servedBy(entry, o.shell)) return { ok: false, error: new EngineError('not_found', `${op.name} is not an operation the ${o.shell} serves`) };
    const p = parsed(op, args);
    if (!p.ok) return p;
    const e = typeof engine === 'function' ? await engine() : engine;
    const refused = op.callers?.(e.caller, p.data);
    if (refused) return { ok: false, error: refused };
    // An imported project not trusted is inert: only reads and the catalogue's allow-list run on it (project-archive/trust.ts).
    // (An engine without a workspace — a test's stand-in — opens no project.)
    const untrusted = e.workspace ? await untrustedOperationRefusal(op.name, p.data, e.workspace, e.envVars ?? {}) : undefined;
    if (untrusted) return { ok: false, error: untrusted };
    const ctx: ToolContext = { engine: e, startedIn: o.startedIn, signal: o.signal, ...(o.progress ? { progress: o.progress } : {}), ...(o.approver ? { approver: o.approver } : {}) };
    const key = op.serialize?.(p.data, e);
    if (key === undefined) return { ok: true, output: await op.run(p.data, ctx) };
    return { ok: true, output: await operationChain(e)(key, () => op.run(p.data, ctx)) };
  } catch (e) {
    return { ok: false, error: failure(e) };
  }
}
