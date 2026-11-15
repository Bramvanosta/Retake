/**
 * The workspace's lines of `retake doctor`: the workspace and its projects, its themes, the MCP registration and the
 * jobs worker, captures first. The workspace is read through its WorkspaceReads (OpenedWorkspace `reads`).
 */
import { join, relative } from 'node:path';
import { RETAKE_VERSION, errorMessage } from '@retake/core/base';
import { WORKSPACE_FILE, WORKSPACE_GITIGNORE, statePath } from '@retake/core/project';
import { clientPath, engineLocation } from '@retake/core/io';
import type { WorkspaceConfig } from '@retake/core/project';
import { tildePath } from '../auth.js';
import { stableNodePath } from '../integrations/config-snippet.js';
import type { OpenedWorkspace } from '../workspace.js';
import { lockText } from './app-checks.js';
import { MIN_NODE_MAJOR, doctorMediaTools } from './machine-checks.js';
import { whichOnPath } from './machine-probes.js';
import { gitWorkTree } from './project-checks.js';
import { firstLine } from './types.js';
import type { CapturesProbe, DoctorCheck, DoctorProbes, WorkerProbe } from './types.js';

/** The workspace's lines: the workspace (its projects), then its themes. */
export async function workspaceChecks(p: DoctorProbes, ws: OpenedWorkspace): Promise<DoctorCheck[]> {
  return [await workspaceCheck(p, ws), ...(await templateChecks(p, ws))];
}

/** The workspace: its root, its marker file, its projects (a WARN without any). */
async function workspaceCheck(p: DoctorProbes, ws: OpenedWorkspace): Promise<DoctorCheck> {
  const marker = p.exists(join(ws.root, WORKSPACE_FILE)) ? WORKSPACE_FILE : `no ${WORKSPACE_FILE}`;
  let projects: Awaited<ReturnType<OpenedWorkspace['reads']['listProjects']>>;
  try {
    projects = await ws.reads.listProjects(ws.root);
  } catch (e) {
    // The one command that diagnoses the workspace says why its projects cannot be listed (never "no projects").
    return {
      status: 'fail',
      name: 'Workspace',
      detail: `${ws.root} (${marker}) · the projects cannot be listed: ${firstLine(errorMessage(e))}`,
      hint: `check that ${ws.projectsDir} is a folder Retake can read`,
    };
  }
  const names = projects.map((x) => x.slug);
  const list = names.length ? `: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}` : '';
  return names.length
    ? { status: 'ok', name: 'Workspace', detail: `${ws.root} (${marker}) · ${names.length} project${names.length === 1 ? '' : 's'}${list}` }
    : {
        status: 'warn',
        name: 'Workspace',
        detail: `${ws.root} (${marker}) · no projects in ${ws.projectsDir}`,
        hint: 'cd into your workspace, pass --root <dir>, set $RETAKE_ROOT, or create a project with retake new <slug>',
      };
}

/** The workspace's themes: one line each (fonts present, or what is missing), a WARN when there is none. */
async function templateChecks(p: DoctorProbes, ws: OpenedWorkspace): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  let templates: Awaited<ReturnType<OpenedWorkspace['reads']['listTemplates']>>;
  try {
    templates = await ws.reads.listTemplates(ws.root);
  } catch (e) {
    return [{ status: 'fail', name: 'Templates', detail: `the themes cannot be listed: ${firstLine(errorMessage(e))}`, hint: `check that ${ws.templatesDir} is a folder Retake can read` }];
  }
  if (!templates.length) {
    // The check names `Templates` / `Template <name>` stay (`retake doctor --json` reads them; docs/GLOSSARY.md).
    out.push({
      status: 'warn',
      name: 'Templates',
      detail: `no themes in ${ws.templatesDir}`,
      hint: p.bundle ? "the app's starter themes are missing: reinstall Retake" : "copy a starter from the repository's templates/ folder",
    });
  }
  for (const t of templates) {
    try {
      const loaded = await ws.reads.loadTemplate(t.dir, ws.root, { files: ws.reads.fileFacts(ws.policy) });
      const fonts = [loaded.assets.display, ...loaded.assets.body];
      const from = t.source === 'starter' ? ' · starter theme' : '';
      out.push({ status: 'ok', name: `Template ${t.name}`, detail: `fonts present (${fonts.length} file${fonts.length === 1 ? '' : 's'})${from}` });
    } catch (e) {
      out.push({ status: 'fail', name: `Template ${t.name}`, detail: errorMessage(e).split('\n')[0], hint: `add the missing files to ${t.dir} or fix template.yaml` });
    }
  }
  return out;
}

/**
 * The MCP line: the Node.js a registration names (`retake mcp --print-config`: a stable alias of it where one
 * exists, so a patch upgrade does not break it), the PATH a GUI client gets from it finds ffmpeg, the jobs worker, and
 * the workspace's `.retake/` (its job queue and history) git-ignored when the workspace is a git work tree.
 */
export async function mcpCheck(p: DoctorProbes, ws: WorkspaceConfig): Promise<DoctorCheck> {
  const name = 'MCP';
  const exec = p.execPath ?? process.execPath;
  const node = stableNodePath(exec, p.exists);
  const parts = [`node ${tildePath(node)}`];
  const warns: Array<{ detail: string; hint: string }> = [];
  if (Number(p.nodeVersion.split('.')[0]) < MIN_NODE_MAJOR) {
    warns.push({ detail: `the registration would name Node.js ${p.nodeVersion}`, hint: `run retake mcp --print-config with Node.js ${MIN_NODE_MAJOR}+` });
  } else if (node === exec && /\/v?\d+\.\d+\.\d+\//.test(node)) {
    warns.push({
      detail: `${tildePath(node)} names a patch version: an upgrade of Node.js removes it`,
      hint: 'register again after an upgrade (retake mcp --print-config), or point it at a version manager alias',
    });
  }
  // What the MCP client's server gets: the registration's PATH and RETAKE_HOME only (the integrations' config snippet)
  // — never the shell's $RETAKE_FFMPEG / $RETAKE_FFPROBE.
  const path = clientPath(node, p.env.PATH ?? '', p.exists);
  const served = doctorMediaTools(p, ws.ffmpeg, { PATH: path });
  if (!('error' in served) && served.ffmpegSource === 'PATH') {
    if (whichOnPath('ffmpeg', { PATH: path }, p.platform)) parts.push('ffmpeg on the PATH it registers');
    else {
      const shellOnly = p.env.RETAKE_FFMPEG?.trim() ? ' ($RETAKE_FFMPEG is set in this shell only: the registration does not carry it)' : '';
      warns.push({
        detail: `ffmpeg is not on the PATH a GUI client gets from the registration${shellOnly}`,
        hint: p.bundle ? 'set ffmpeg: in retake.yaml' : 'install ffmpeg (Homebrew), or set ffmpeg: in retake.yaml',
      });
    }
  }
  let worker: WorkerProbe | null = null;
  let unread = false;
  try {
    worker = p.worker ? await p.worker(ws.root) : null;
  } catch (e) {
    unread = true;
    warns.push({
      detail: `the jobs worker's state cannot be read: ${firstLine(errorMessage(e))}`,
      hint: `check that ${statePath(ws.root)} can be read; a job submitted now may wait for a worker that is already there`,
    });
  }
  parts.push(
    worker
      ? `worker running (pid ${worker.pid}${worker.started_by ? `, started by ${lockText(worker.started_by)}` : ''})`
      : unread
        ? 'worker state unknown'
        : 'worker idle (a client starts it with its first job)',
  );
  // The workspace's worker runs another copy of Retake — jobs submitted here run with its tools.
  const self = p.engine ?? engineLocation(p.bundle ?? null);
  if (worker && ((worker.engine !== undefined && worker.engine !== self) || (worker.version !== undefined && worker.version !== RETAKE_VERSION))) {
    warns.push({
      detail: `this workspace's worker runs another copy of Retake (${lockText(worker.version ?? '?')}${worker.engine ? `, ${lockText(tildePath(worker.engine))}` : ''}) than this one (${RETAKE_VERSION}, ${tildePath(self)})`,
      hint: "jobs submitted now run with that copy's browsers and tools: let it finish, it exits a minute after its last job — the next submit starts this copy's",
    });
  }
  const tree = gitWorkTree(p, ws.root);
  if (tree) {
    const rel = relative(tree, statePath(ws.root));
    const res = await p.exec('git', ['-C', tree, 'check-ignore', '-q', `${rel}/`], 5000);
    if (res?.code !== 0)
      warns.push({
        detail: `${tildePath(statePath(ws.root))} (the job queue and history of this machine) is not ignored by git`,
        hint: `add ${WORKSPACE_GITIGNORE.join(', ')} to the workspace's .gitignore`,
      });
  }
  if (warns.length) return { status: 'warn', name, detail: [...warns.map((w) => w.detail), ...parts].join(' · '), hint: warns.map((w) => w.hint).join('; ') };
  return { status: 'ok', name, detail: `${parts.join(' · ')} · register: retake mcp --print-config` };
}

/**
 * "Captures first": the takes filming now on this Mac for this user (counted, never named: in this workspace or
 * elsewhere), the markers' folder, whether a running render can be slowed (background priority) or only made to wait,
 * the cap. WARN when the folder cannot be used (captures first is off) or a marker's owner is not a Retake process (it
 * holds renders up to the cap).
 */
export function capturesCheck(c: CapturesProbe): DoctorCheck {
  const name = 'Captures first';
  const live = c.takes.filter((t) => !t.paused);
  const here = live.filter((t) => t.here).length;
  const where = [...(here ? [`${here} in this workspace`] : []), ...(live.length - here ? [`${live.length - here} elsewhere on this Mac`] : [])].join(', ');
  const capped = live.filter((t) => t.capped).length;
  const filming = live.length
    ? `${live.length === 1 ? '1 take films' : `${live.length} takes film`} now (${where}): renders, reviews, exports and previews wait for ${live.length === 1 ? 'it' : 'them'}${c.qos ? ' and run at background priority meanwhile' : ''}${capped ? ` — ${capped} past the ${c.capMin}-min cap, which hold${capped === 1 ? 's' : ''} nothing any more` : ''}`
    : 'no take films now';
  const paused = c.takes.length - live.length;
  const parts = [
    filming,
    ...(paused ? [`${paused} paused (holding nothing)`] : []),
    `markers: ${tildePath(c.dir)} (${c.override ? 'set by RETAKE_CAPTURES_DIR' : 'this user on this Mac'}${c.exists ? '' : '; made by the first take'})`,
    c.qos ? 'a render running when a take starts is slowed (background priority)' : 'no background priority here: a running render is not slowed, new heavy jobs only wait',
    `cap ${c.capMin} min (RETAKE_CAPTURE_HOLD_MAX_MIN)`,
  ];
  if (c.problem)
    return {
      status: 'warn',
      name,
      detail: [c.problem, ...parts.slice(1)].join(' · '),
      hint: 'captures first is off until the folder is a directory of this user, mode 0700 (or set RETAKE_CAPTURES_DIR to one)',
    };
  const foreign = c.takes.filter((t) => !t.retake).length;
  if (foreign) {
    return {
      status: 'warn',
      name,
      detail: [`${foreign === 1 ? 'a filming marker whose owner is' : `${foreign} filming markers whose owners are`} not a Retake process`, ...parts].join(' · '),
      hint: `such a marker holds renders for up to ${c.capMin} min; if no take films, remove the k_*.json files in ${tildePath(c.dir)}`,
    };
  }
  return { status: 'ok', name, detail: parts.join(' · ') };
}
