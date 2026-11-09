/** A rule of the operation catalogue the shells' tests share: an operation's kind agrees with its annotations. */
import type { OperationKind, ToolAnnotations } from '@retake/engine/contract';

/**
 * Why an operation's kind and its annotations disagree, or undefined when they agree: `read` exactly when read-only;
 * `destructive` is marked destructive; a destructive mark is `destructive` or `runs_code` (a hook may write or delete).
 */
export function kindProblem(kind: OperationKind, a: ToolAnnotations): string | undefined {
  if ((kind === 'read') !== (a.readOnlyHint === true)) return `kind ${kind} but readOnlyHint ${a.readOnlyHint}`;
  if (kind === 'destructive' && a.destructiveHint !== true) return 'kind destructive but no destructiveHint';
  if (a.destructiveHint === true && kind !== 'destructive' && kind !== 'runs_code') return `kind ${kind} but destructiveHint`;
  return undefined;
}
