/** Test helpers of the engine's own tests (the fixture workspace is shared: @retake/test-support/workspace). */
import { callerOf, enginePorts } from '../src/index.js';
import type { StoreScope } from '../src/index.js';

/**
 * The scope a comment of `author` was written under before L7.10 made the scope required (the caller its channel
 * stands for, the product's ports): what a test that writes a thread directly hands.
 */
export function authorScope(project: { root: string }, author: { via: string; name?: string }): StoreScope {
  return { workspace: project.root, caller: callerOf(author.via === 'cli' ? 'cli' : author.via === 'studio' ? 'ui' : 'mcp'), ...enginePorts() };
}
