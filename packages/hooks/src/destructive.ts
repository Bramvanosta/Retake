import { destructiveReason } from '@demo-studio/core';
import type { DestructiveOptions, HookStep } from '@demo-studio/core';

/**
 * Destructive-hook detection is shared with scenario validation (core): what validation flags is exactly what
 * the hook runner refuses without `confirm: true`.
 */
export { destructiveReason, psqlDestructiveStatement, shellDestructiveReason, shellWords } from '@demo-studio/core';
export type { DestructiveOptions };

export function isDestructive(hook: HookStep, opts: DestructiveOptions = {}): boolean {
  return destructiveReason(hook, opts) !== null;
}
