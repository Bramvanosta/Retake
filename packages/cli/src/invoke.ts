/**
 * One operation call of a command, as the MCP server and the Studio make theirs: through the engine's `invoke`, served
 * by the shell `cli` (the catalogue's `cli` entry), on the command's engine (caller `cli`: a person at a terminal).
 * The command prints from the operation's `data`; a refusal comes back as the operation's EngineError, thrown, so that
 * the command's own error handling (its words, its exit code) stays as it was.
 */
import { invoke } from '@retake/engine/contract';
import type { ToolDef, ToolOutput } from '@retake/engine/contract';
import type { Engine } from '@retake/engine';

export async function invokeOperation<D extends object>(op: ToolDef<ToolDef['input'], D>, engine: Engine, args: unknown): Promise<ToolOutput<D>> {
  // A command is not cancelled by a client: its Ctrl-C ends the process (interrupt.ts), so the call's signal never fires.
  const r = await invoke(op, engine, args, { shell: 'cli', signal: new AbortController().signal });
  if (!r.ok) throw r.error;
  return r.output;
}
