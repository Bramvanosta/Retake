/**
 * What a project archive (`retake project export`, a project in one ZIP) never holds, and how it is laid out: shared by
 * the export (what it leaves out) and the import (what it refuses). Judged on the folded key of each segment
 * (archive-names.ts foldedArchiveKey), so `.ENV.local`, `.Retake/` or `ID_RSA` are caught however they are spelt.
 * Pure: no I/O. The folder names are the layout's (layout.ts).
 *
 * Never in an archive:
 * - `state` — the project's state folder (`.retake/`: locks, journals, sessions' copies, the import marker);
 * - `env` — any `.env*` file or folder (the sandbox's secrets);
 * - `exports` — what the project exported (a raw package, a project archive);
 * - `env` also catches an env file by its suffix (`prod.env`, `app.env.local`);
 * - `sensitive` — key and credential files: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `*.kdbx`,
 *   `*.ovpn`, `*.ppk`, `id_*` (an SSH key), `.netrc`, `.npmrc`, `.pgpass`, `.pypirc`, `.htpasswd`, `.git-credentials`,
 *   `credentials` (any extension), `service-account*.json`, `*.tfstate*`, and every file of `.aws/`, `.ssh/`,
 *   `.docker/`, `.gnupg/`, `.kube/`, `.azure/`, `.gcloud/` and `.auth/` (a saved browser sign-in: `playwright/.auth/`);
 * - `noise` — what no project needs: `.git/`, `node_modules/`, `.DS_Store`.
 * Runs, renders and reviews (`runs/`, `renders/`, `review/`) go in only when asked (`--with-runs`).
 */
import { foldedArchiveKey } from './archive-names.js';
import { PROJECT_DIRS, STATE_DIR } from './layout.js';

/** The manifest's entry name, the last entry of an archive. */
export const PROJECT_ARCHIVE_MANIFEST = 'retake-project.json';
/** The folder of an archive that holds the project's tree, as the import writes it. */
export const PROJECT_ARCHIVE_ROOT = 'project/';
/** The `format` a project archive's manifest names. */
export const PROJECT_ARCHIVE_FORMAT = 'retake-project';

/** Why a path never goes into a project archive. */
export type NeverArchived = 'state' | 'env' | 'exports' | 'sensitive' | 'noise';

/** The folders of what a project made: in an archive only with `--with-runs`. */
export const PROJECT_OUTPUT_FOLDERS = [PROJECT_DIRS.runs, PROJECT_DIRS.renders, PROJECT_DIRS.review] as const;

const NOISE = new Set(['.git', 'node_modules', '.ds_store']);
/** Folders whose files are credentials whatever their names (cloud, SSH, container, cluster keys; a browser's saved sign-in). */
const SENSITIVE_FOLDERS = new Set(['.aws', '.ssh', '.docker', '.gnupg', '.kube', '.auth', '.azure', '.gcloud']);
const SENSITIVE_NAMES = new Set(['.netrc', '.npmrc', '.pgpass', '.pypirc', '.htpasswd', '.git-credentials', 'credentials']);
const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.kdbx', '.ovpn', '.ppk'];

/** Whether a file name (one segment) is a key or credential file. */
export function sensitiveName(segment: string): boolean {
  const k = foldedArchiveKey(segment);
  if (SENSITIVE_NAMES.has(k)) return true;
  if (k.startsWith('id_')) return true;
  if (/^(credentials|service-account|service_account)[^/]*\.json$/.test(k) || /^credentials\./.test(k)) return true;
  if (/\.tfstate(\.|$)/.test(k)) return true;
  return SENSITIVE_EXTENSIONS.some((e) => k.endsWith(e));
}

/** Whether a file name is an env file by its suffix (`prod.env`, `app.env.local`); a `.env*` prefix is caught first. */
const envSuffix = (k: string): boolean => /\.env(\.|$)/.test(k);

/**
 * Why the project path `rel` (relative to the project folder, `/` separators) never goes into an archive, or
 * undefined. The first rule a segment meets wins, from the top: a `.retake` segment anywhere is state.
 */
export function neverArchived(rel: string): NeverArchived | undefined {
  const segments = rel.split('/').filter((s) => s !== '');
  if (!segments.length) return undefined;
  if (foldedArchiveKey(segments[0]!) === PROJECT_DIRS.exports) return 'exports';
  for (const s of segments) {
    const k = foldedArchiveKey(s);
    if (k === STATE_DIR) return 'state';
    if (k.startsWith('.env') || envSuffix(k)) return 'env';
    if (NOISE.has(k)) return 'noise';
  }
  const folders = segments.slice(0, -1).map(foldedArchiveKey);
  if (folders.some((f) => SENSITIVE_FOLDERS.has(f))) return 'sensitive';
  // A browser's saved sign-in kept by a test tool (`playwright/.auth/`), caught by `.auth` above.
  return sensitiveName(segments[segments.length - 1]!) ? 'sensitive' : undefined;
}

/** The project's top-level names of the layout (folders, project.yaml) and the record files a reader opens by name. */
const LAYOUT_TOP = [...Object.values(PROJECT_DIRS), 'templates', 'components', 'brand', 'project.yaml'];
const LAYOUT_FILES_BY_NAME = ['run.json', 'report.json', 'timeline.json', 'template.yaml', 'component.yaml', 'sandbox.yaml'];

/**
 * Why a project path spells a name of the layout otherwise than the layout does (`Runs/`, `RUN.JSON`, a render record
 * `renders/Quote-V1.JSON`), or undefined: on a case-insensitive disk every reader would open it under the layout's name,
 * past the checks an import makes on that name. An archive spells them as Retake writes them.
 */
export function layoutSpellingProblem(rel: string): string | undefined {
  const segments = rel.split('/');
  const top = segments[0] ?? '';
  const t = LAYOUT_TOP.find((n) => n === foldedArchiveKey(top));
  if (t !== undefined && t !== top) return `${top} (the layout's ${t})`;
  for (const s of segments.slice(1)) {
    const n = LAYOUT_FILES_BY_NAME.find((x) => x === foldedArchiveKey(s));
    if (n !== undefined && n !== s) return `${s} (the layout's ${n})`;
  }
  // A render record and its files are named by a render id: lower case.
  if (top === PROJECT_DIRS.renders && segments.length === 2 && segments[1] !== segments[1]!.toLowerCase()) return `${segments[1]} (a render's names are lower case)`;
  return undefined;
}

/** Whether the project path `rel` lies in a folder of what the project made (runs/, renders/, review/). */
export function projectOutputPath(rel: string): boolean {
  const first = foldedArchiveKey(rel.split('/')[0] ?? '');
  return (PROJECT_OUTPUT_FOLDERS as readonly string[]).includes(first);
}

/** Common prefixes of literal tokens (an API key, a chat token, a cloud key, a PEM block): flagged, never printed. */
const TOKEN_PREFIXES = /(?:^|[^A-Za-z0-9])(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|gh[ousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

/** The 1-based numbers of the lines of `text` that hold something shaped like a literal token (never the token). */
export function literalTokenLines(text: string): number[] {
  const out: number[] = [];
  text.split('\n').forEach((l, i) => {
    if (TOKEN_PREFIXES.test(l)) out.push(i + 1);
  });
  return out;
}
