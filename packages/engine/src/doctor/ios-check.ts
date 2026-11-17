/**
 * `retake doctor`'s iOS lines: the "iOS Simulator" line (Xcode, its newest iOS runtime, whether the driver is built
 * here or builds on the first run) and, with `--project`, one line per iOS environment (its device type known to this
 * Xcode, its app built for the simulator). Only iOS environments need any of it: a machine without Xcode gets no line
 * unless the --project has one — then a WARN, a FAIL when its default environment (the one a run picks without --env)
 * is an iOS one. `xcode-select -p` is asked first: `xcrun` on a Mac without developer tools opens the system's
 * "install the command line tools" prompt, so it never runs then. Programs run through the probes (`exec`), never here.
 */
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homeIosDriverCache } from '@retake/core/io';
import { iosAppKind } from '@retake/core/environment';
import type { IosSettings } from '@retake/core/environment';
import { openProject } from '../workspace.js';
import type { OpenedWorkspace } from '../workspace.js';
import { firstLine } from './types.js';
import type { DoctorCheck, DoctorProbes } from './types.js';

/** Who needs the iOS Simulator: the iOS environments of the --project, and whether its default environment is one. */
export interface IosNeed {
  /** "the iOS environment simulator of project buyer". */
  by: string;
  required: boolean;
  /** The project's folder (an app path is relative to it). */
  projectDir: string;
  envs: Array<{ name: string; ios: IosSettings }>;
}

/** The iOS environments of a project, or null (none, or a project that cannot be read: its own line says why). */
export async function iosNeedOf(ws: OpenedWorkspace, slug: string): Promise<IosNeed | null> {
  try {
    const project = await openProject(ws, slug);
    const settings = project.config.environment_settings ?? {};
    const names = Object.keys(project.config.environments ?? {});
    const envs = names.filter((n) => settings[n]?.ios).map((n) => ({ name: n, ios: settings[n].ios as IosSettings }));
    if (!envs.length) return null;
    const def = project.config.default_env ?? names[0];
    const required = envs.some((e) => e.name === def);
    const shown = envs.map((e) => e.name);
    return { by: `the iOS environment${shown.length === 1 ? '' : 's'} ${shown.join(', ')} of project ${project.slug}`, required, projectDir: project.dir, envs };
  } catch {
    return null;
  }
}

/** a > b, part by part ("26.5" > "18.2"). Pure. */
function versionAfter(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

/** The newest available iOS runtime of `simctl list runtimes -j` and the device types it runs (null: none). Pure. */
export function newestIosRuntime(json: string): { name: string; types: string[] } | null {
  let best: { name: string; version: number[]; types: string[] } | null = null;
  try {
    const list = (JSON.parse(json) as { runtimes?: Array<Record<string, unknown>> }).runtimes ?? [];
    for (const r of list) {
      if (r.isAvailable === false || (r.platform !== 'iOS' && !String(r.name ?? '').startsWith('iOS '))) continue;
      const version = String(r.version ?? '0')
        .split('.')
        .map(Number);
      const types = Array.isArray(r.supportedDeviceTypes) ? (r.supportedDeviceTypes as Array<{ name?: string }>).map((t) => String(t?.name ?? '')) : [];
      if (!best || versionAfter(version, best.version)) best = { name: String(r.name ?? ''), version, types };
    }
  } catch {
    return null;
  }
  return best ? { name: best.name, types: best.types } : null;
}

/** The iOS Simulator line (null off a Mac when nothing needs it). */
export async function iosSimulatorCheck(p: DoctorProbes, need: IosNeed | null): Promise<{ line: DoctorCheck; runtime: { name: string; types: string[] } | null } | null> {
  const name = 'iOS Simulator';
  // Nothing needs it: no line when it is missing (a web-only machine is not told about Xcode).
  const bad = (detail: string, hint: string) =>
    need ? { line: { status: need.required ? ('fail' as const) : ('warn' as const), name, detail: `${detail} — needed by ${need.by}`, hint }, runtime: null } : null;
  if (p.platform !== 'darwin') return bad('the iOS Simulator runs on a Mac only', 'run the iOS environments on a Mac with Xcode');
  const install = 'install Xcode (the App Store), open it once, then: sudo xcode-select -s /Applications/Xcode.app';
  // No developer folder: xcrun would open the system's install prompt — never run it then.
  const dev = await p.exec('xcode-select', ['-p'], 10_000);
  if (dev?.code !== 0 || !dev.stdout.trim()) return bad('Xcode is not installed (xcode-select -p names no developer folder)', install);
  const v = await p.exec('xcrun', ['xcodebuild', '-version'], 20_000);
  if (!v) return bad('xcrun not found', install);
  if (v.code !== 0) return bad(`Xcode is not usable (${firstLine(v.stderr) || `exit ${v.code}`})`, install);
  const xcode = /Xcode\s+(\S+)/.exec(v.stdout)?.[1] ?? '?';
  const build = /Build version\s+(\S+)/.exec(v.stdout)?.[1] ?? '?';
  const r = await p.exec('xcrun', ['simctl', 'list', 'runtimes', '-j'], 30_000);
  const runtime = r && r.code === 0 ? newestIosRuntime(r.stdout) : null;
  if (!runtime) return bad(`Xcode ${xcode} (${build}) has no iOS simulator runtime`, 'add one in Xcode → Settings → Components (iOS)');
  // The driver's builds live in <Retake home>/ios-driver/<Xcode build>-<sources>: one for this Xcode is built here.
  const cache = dirname(homeIosDriverCache('x', p.env as NodeJS.ProcessEnv));
  const built = (p.list?.(cache) ?? []).some((f) => f.startsWith(`${build}-`));
  const driver = built ? 'driver built' : 'the driver builds on the first run (about 10 s)';
  return { line: { status: 'ok', name, detail: `Xcode ${xcode} (${build}) · ${runtime.name} · ${driver}` }, runtime };
}

/** One line per iOS environment of the --project: its device type and its app. */
export async function iosEnvironmentChecks(p: DoctorProbes, need: IosNeed, runtime: { name: string; types: string[] } | null): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  for (const { name, ios } of need.envs) {
    const line = `iOS ${name}`;
    const fail = (detail: string, hint: string): DoctorCheck => ({ status: need.required ? 'fail' : 'warn', name: line, detail, hint });
    if (runtime && !runtime.types.includes(ios.device)) {
      out.push(
        fail(
          `device "${ios.device}" is not a device type ${runtime.name} runs`,
          `pick one of: ${runtime.types
            .filter((t) => t.startsWith('iPhone'))
            .slice(-6)
            .join(', ')}`,
        ),
      );
      continue;
    }
    const app = ios.app.trim();
    if (iosAppKind(app) !== 'path') {
      out.push({ status: 'ok', name: line, detail: `${ios.device} · app ${app} (installed on the run's simulator: checked when the run starts)` });
      continue;
    }
    const path = isAbsolute(app) ? app : resolve(need.projectDir, app);
    if (!p.exists(join(path, 'Info.plist'))) {
      out.push(fail(`app ${app} is not built (${path})`, 'build it for the simulator (-sdk iphonesimulator) and point `app` at the .app'));
      continue;
    }
    const plat = await p.exec('plutil', ['-extract', 'DTPlatformName', 'raw', '-o', '-', join(path, 'Info.plist')], 10_000);
    const platform = plat?.code === 0 ? plat.stdout.trim() : '';
    if (platform !== 'iphonesimulator') {
      out.push(fail(`app ${app} is built for ${platform || 'an unknown platform'}, not the iOS Simulator`, 'build it with -sdk iphonesimulator'));
      continue;
    }
    out.push({ status: 'ok', name: line, detail: `${ios.device} · app ${app}` });
  }
  return out;
}
