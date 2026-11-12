import { destructiveReason } from '@retake/core/hooks';
import type { HookStep } from '@retake/core/model';
import type { DestructiveOptions } from '@retake/core/hooks';

/**
 * Destructive-hook detection is shared with scenario validation (core): what validation flags is exactly what
 * the hook runner refuses without `confirm: true`.
 */
export { shellWords } from '@retake/core/base';
export { destructiveReason, psqlDestructiveStatement, shellDestructiveReason } from '@retake/core/hooks';
export type { DestructiveOptions };

export function isDestructive(hook: HookStep, opts: DestructiveOptions = {}): boolean {
  return destructiveReason(hook, opts) !== null;
}
