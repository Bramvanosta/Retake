/**
 * Versioned file formats (R-PRIN-13). Every file Retake reads and writes says which version of its format it is
 * (`version:`): scenarios, project.yaml, template.yaml, retake.yaml and run.json (optional: a file without it is
 * version 1); timeline.json, the hooks journal, render and review records, raw manifests and sandbox.yaml (required).
 * A file of a higher version than this Retake reads is refused with one message — it was made for a newer Retake
 * — instead of a flood of unknown-key errors. Retake never rewrites a user's file to another version.
 */

/**
 * The version of Retake (`retake --version`, run.json `engine.retake`, the app). One number: the root package.json's,
 * repeated here, in every package.json, apps/desktop/tauri.conf.json, skills/.claude-plugin/plugin.json and
 * apps/desktop/Cargo.toml (a test keeps them equal).
 */
export const RETAKE_VERSION = '0.2.0';

/**
 * Where Retake's repository is read on the web: the root package.json's `repository` field (its URL without `git+` and
 * `.git`), repeated here (a test keeps them equal). The documentation URLs of errors point into it (error-kind.ts).
 */
export const RETAKE_REPOSITORY = 'https://github.com/Bramvanosta/Retake';

/** The format version of each file this Retake reads and writes (a file without `version` is version 1). */
export const FORMAT_VERSIONS = { scenario: 1, project: 1, template: 1, workspace: 1, run: 1 } as const;

/** A file's format, for the newer-version check: how messages name it and the highest version this Retake reads. */
export interface FormatVersion {
  /** "scenario", "project.yaml", "run.json"… */
  file: string;
  supported: number;
}

/**
 * The refusal of a file made for a newer Retake: its `version` is an integer above the supported one. Undefined
 * otherwise — a missing version reads as 1, and 0, "1" or 1.5 are left to the schema (plain errors).
 */
export function newerFormatMessage(value: unknown, format: FormatVersion): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = (value as { version?: unknown }).version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= format.supported) return undefined;
  return `this ${format.file} is version ${v}: it was made for a newer Retake (this one reads version ${format.supported}) — update Retake`;
}
