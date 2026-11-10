/**
 * L6.12–L6.13: the app's typed operation client — the one door of the app's data modules to `POST /v1/call/<op>`.
 * Each data module (data/<feature>.ts) names its ops once: `op('theme_edit')` is the function a screen calls with that
 * op's arguments and that resolves to its result (StudioOps: both derived from the Studio's op table);
 * `readHook('theme_list')` is the matching `useCall` read. Nothing outside data/ imports `call` / `useCall`
 * (packages/ui/test/feature-boundaries.test.ts). Same requests on the wire as `call(op, args, o)`: these only type them.
 */
import { call, useCall } from '../api.js';
import type { CallOptions, Loaded, OpArgs, OpParams, OpResult } from '../api.js';
import type { StudioOp } from './ops.js';

export type { CallOptions, OpArgs, OpResult };

/** One op as a function: its arguments (optional when the op needs none), the call's options; its result. */
export type OpCall<K extends StudioOp> = (...a: OpParams<K>) => Promise<OpResult<K>>;
/**
 * A read's parameters: its arguments and the key that reloads it — the arguments left out when the op needs none, as
 * for a call (OpParams): `useEngineInfo('info')` is `useEngineInfo({}, 'info')`.
 */
export type ReadParams<K extends StudioOp> = {} extends OpArgs<K> ? [key: string] | [args: OpArgs<K>, key: string] : [args: OpArgs<K>, key: string];
/** One op as a `useCall` read: its arguments (optional when the op needs none) and the key that reloads it. */
export type OpRead<K extends StudioOp> = (...a: ReadParams<K>) => [Loaded<OpResult<K>>, () => void];

/** The function of one op: `call(name, args, o)`. */
export function op<K extends StudioOp>(name: K): OpCall<K> {
  return (...a: OpParams<K>) => call(name, ...a);
}

/** The read of one op for a component: `useCall(name, args, key)` (a hook: call it as one, at the top of a component). */
export function readHook<K extends StudioOp>(name: K): OpRead<K> {
  return (...a: ReadParams<K>) => {
    const [args, key] = (a.length === 1 ? [{}, a[0]] : a) as [OpArgs<K>, string];
    return useCall(name, args, key);
  };
}
