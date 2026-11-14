/**
 * @retake/core/base — the kernel every context builds on: text and path helpers, issues and their positions, error
 * kinds, file-format versions, canonical JSON, printable text, token templating, YAML validation.
 *
 * A context of core (L7.35, audit 2026-11-10 D1): its files may import the contexts before it (none); the ratchet's
 * `core-context` check holds it (scripts/audit/lib.mjs CORE_CONTEXTS). Each name is exported by the entry of the file
 * that declares it; the root `@retake/core` is every entry at once, for tests and scripts (the packages' sources import
 * an entry: the `core-root` check).
 */
export * from '../util.js';
export * from '../issues.js';
export * from '../error-kind.js';
export * from '../formats.js';
export * from '../canonical-json.js';
export * from '../printable.js';
export * from '../line-diff.js';
export * from '../path-inside.js';
export * from '../templating.js';
export { isoDay, parseDay } from '../dates.js';
export { bestEffort } from '../best-effort.js';
export { isUnder } from '../client-path.js';
export { maskSql } from '../sql-text.js';
export { SHELL_OPERATORS, commandName, heredocs, lexShell, nestedShellScript, shellCommands, shellInvocation, shellTokens, shellWords } from '../shell-words.js';
export type { Heredoc, LexOptions, ShellCall, ShellCommand, ShellToken } from '../shell-words.js';
export { brokenUnder, checkYamlDocument } from '../validation/document.js';
export type { CheckDocumentOptions, CheckedDocument } from '../validation/document.js';
export { finalizeIssues, issue as locatedIssue } from '../validation/located.js';
export type { LocatedIssue } from '../validation/located.js';
export { didYouMean, editDistance, suggestion } from '../validation/suggest.js';
export { attachPositions, locateOffset, parseYaml } from '../validation/yaml-source.js';
export type { ParsedYaml, YamlSource } from '../validation/yaml-source.js';
export { describeValue, zodIssues } from '../validation/zod-issues.js';
