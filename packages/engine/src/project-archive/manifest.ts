/**
 * The manifest of a project archive (`retake-project.json`, its last entry): what the archive holds and what the
 * project needs on the machine it goes to — names only, never a value. Version 1 (core formats.ts
 * FORMAT_VERSIONS.project_archive); a newer one is refused with the newer-format sentence.
 *
 * Nothing in it is trusted at import: the files are checked against it (each entry listed once, its size and its sha256
 * the bytes written), the code files and what the project asks of the machine are recomputed from the files written,
 * and every string an answer shows from it is shown with its hidden characters written out.
 */
import { z } from 'zod';
import { FORMAT_VERSIONS } from '@retake/core/base';
import { PROJECT_ARCHIVE_FORMAT, PROJECT_SLUG_RE } from '@retake/core/project';

/** Where a file of an archive came from: the project's own, or a workspace theme or component it uses (embedded). */
export const ARCHIVE_ORIGINS = ['project', 'workspace-theme', 'workspace-component'] as const;
export type ArchiveOrigin = (typeof ARCHIVE_ORIGINS)[number];

const name = z.string().max(1024);
const names = z.array(name).max(10_000);

export const ManifestFileSchema = z.object({
  /** Project-relative, `/` separators (the archive's entry is `project/<path>`). */
  path: name,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mode: z.enum(['644', '755']),
  origin: z.enum(ARCHIVE_ORIGINS),
});
export type ManifestFile = z.infer<typeof ManifestFileSchema>;

/** What the project needs where it goes: the names of its secrets, the variables passed on, the personas to sign in. */
export const NeedsSchema = z.object({
  env_vars: names,
  keychain: names,
  pass_env: names,
  sessions: z.array(z.object({ env: name, persona: name })).max(10_000),
});
export type ArchiveNeeds = z.infer<typeof NeedsSchema>;

/**
 * What was left out, by project path: `.env*` files, key and credential files, links and special files; with the runs,
 * the renders whose record names files outside the project (a starter's or a workspace theme's: they would not import),
 * by render id, their files and reviews with them.
 */
export const ExcludedSchema = z.object({ env: names, sensitive: names, links: names, special: names, outside_renders: names });
export type ArchiveExcluded = z.infer<typeof ExcludedSchema>;

/** The lines of files that hold what looks like a literal token (never the token): warned at export, never removed. */
export const TokenWarningSchema = z.object({ file: name, lines: z.array(z.number().int().positive()).max(1000), what: z.string().max(200) });
export type TokenWarning = z.infer<typeof TokenWarningSchema>;

export const ManifestSchema = z.object({
  format: z.literal(PROJECT_ARCHIVE_FORMAT),
  version: z.literal(FORMAT_VERSIONS.project_archive),
  retake_version: z.string().max(100),
  created_at: z.string().max(100),
  project: z.object({ slug: z.string().regex(PROJECT_SLUG_RE).max(100), name: z.string().max(500) }),
  /** The options it was made with (a later Retake adds the sandbox's). */
  options: z.object({ with_runs: z.boolean() }),
  files: z.array(ManifestFileSchema).max(100_000),
  embedded: z.object({ themes: names, components: names }),
  uses: z.object({ starters: names, builtin_components: names }),
  needs: NeedsSchema,
  excluded: ExcludedSchema,
  warnings: z.object({ literal_tokens: z.array(TokenWarningSchema).max(10_000) }),
  /** What `retake project trust` will list, as the exporter saw it (informational: the import recomputes it). */
  code_files: names,
});
export type ProjectManifest = z.infer<typeof ManifestSchema>;
