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

/**
 * Where a file of an archive came from: the project's own, a workspace theme or component it uses (embedded), a
 * compose file of its sandbox that lay outside the project (`sandbox`: copied next to sandbox.yaml), or the sandbox's
 * env file (`env`: only with a person's `--with-env`).
 */
export const ARCHIVE_ORIGINS = ['project', 'workspace-theme', 'workspace-component', 'sandbox', 'env'] as const;
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

/** A path a sandbox names that the archive does not carry, and what it is (a person provides it). */
const OutsideSchema = z.object({ ref: name, what: z.string().max(300) });

/**
 * What the archive says of one sandbox (`--with-sandbox`): its compose files copied from outside the project (`copied`:
 * from — as the exporter's machine named it, relative to the project — to their project path), the files rewritten
 * (sandbox.yaml's compose paths), what it names and the archive does not carry (`outside`: a build context, a seed
 * file, a process service's folder, an include), its bind mounts (never copied), its env files by key names (the
 * sandbox's own included only with `--with-env`), the images its services run.
 */
export const SandboxPartSchema = z.object({
  env: name,
  provider: z.enum(['process', 'docker-compose']),
  copied: z.array(z.object({ from: name, to: name })).max(1000),
  rewritten: names,
  outside: z.array(OutsideSchema).max(10_000),
  /** `expected_at`: where the mount resolves once imported (a project path, or a host path): where to put its folder. */
  host_mounts: z.array(z.object({ service: name, source: name, target: name, expected_at: name.optional() })).max(10_000),
  /** `from`: the file the exporter's machine read (as shown); `path`: where it goes, or must be put, in the project. */
  env_file: z.object({ path: name, from: name.optional(), keys: names, included: z.boolean() }).optional(),
  service_env_files: z.array(z.object({ service: name, path: name, keys: names, expected_at: name.optional() })).max(10_000),
  images: z.array(z.object({ service: name, name, id: z.string().regex(/^sha256:[0-9a-f]{64}$/) })).max(1000),
});
export type SandboxPart = z.infer<typeof SandboxPartSchema>;

/** An image saved in the archive (`entry`: `images/sha256-<hex>.tar.gz`, gzipped `docker save <id>`): its sizes and platform. */
export const ManifestImageSchema = z.object({
  id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  entry: z.string().regex(/^images\/sha256-[0-9a-f]{64}\.tar\.gz$/),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  platform: z.string().max(100),
  /** Uncompressed bytes, as docker said. */
  size: z.number().int().nonnegative(),
});
export type ManifestImage = z.infer<typeof ManifestImageSchema>;

export const ManifestSchema = z.object({
  format: z.literal(PROJECT_ARCHIVE_FORMAT),
  version: z.literal(FORMAT_VERSIONS.project_archive),
  retake_version: z.string().max(100),
  created_at: z.string().max(100),
  project: z.object({ slug: z.string().regex(PROJECT_SLUG_RE).max(100), name: z.string().max(500) }),
  /** The options it was made with (a later Retake adds the sandbox's). */
  options: z.object({ with_runs: z.boolean(), with_sandbox: z.boolean().optional(), with_env: z.boolean().optional(), images: z.boolean().optional() }),
  files: z.array(ManifestFileSchema).max(100_000),
  embedded: z.object({ themes: names, components: names }),
  uses: z.object({ starters: names, builtin_components: names }),
  needs: NeedsSchema,
  excluded: ExcludedSchema,
  warnings: z.object({ literal_tokens: z.array(TokenWarningSchema).max(10_000) }),
  /** What `retake project trust` will list, as the exporter saw it (informational: the import recomputes it). */
  code_files: names,
  /** `--with-sandbox`: what the archive says of each sandbox, and the images it carries. */
  sandbox: z.array(SandboxPartSchema).max(100).optional(),
  images: z.array(ManifestImageSchema).max(1000).optional(),
});
export type ProjectManifest = z.infer<typeof ManifestSchema>;
