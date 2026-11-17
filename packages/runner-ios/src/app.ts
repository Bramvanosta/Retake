/**
 * The app an iOS run films: its environment's `app` checked under the work's policy (core iosAppTarget: a bundle id,
 * or the real path of a simulator build), a build's Info.plist read (built for the simulator, its bundle id), and
 * installed on the device before each take — an app named by its bundle id must be installed already.
 */
import { join } from 'node:path';
import { IOS_BUNDLE_ID_RE } from '@retake/core/environment';
import { iosAppTarget } from '@retake/core/policy';
import type { WorkPolicy } from '@retake/core/policy';
import type { FileFacts } from '@retake/core/model';
import type { Exec } from './proc.js';
import type { Simctl } from './simctl.js';

/** The app of a run: its bundle id, and the build to install (absent: installed already). */
export interface RunApp {
  bundleId: string;
  path?: string;
}

/** What the app check reads of a build's Info.plist. */
export interface AppInfo {
  platform: string;
  bundleId: string;
}

/** The app of an environment, or why it may not be filmed: its bundle id and build (Info.plist checked). */
export async function resolveApp(app: string, o: { projectDir: string; policy: WorkPolicy; files: FileFacts; exec: Exec; plutil: string }): Promise<RunApp> {
  const checked = iosAppTarget(app, { projectDir: o.projectDir, policy: o.policy, files: o.files });
  if (checked.problem !== null) throw new Error(checked.problem);
  const t = checked.target;
  if (t.kind === 'bundle') return { bundleId: t.bundleId };
  if (o.files.kind(t.path) !== 'directory') throw new Error(`app ${t.path} is not there: build it for the simulator first (the .app folder of its Build/Products/Debug-iphonesimulator)`);
  const info = await appInfo(o.exec, o.plutil, t.path);
  const problem = appInfoProblem(info, t.path);
  if (problem) throw new Error(problem);
  return { bundleId: info.bundleId, path: t.path };
}

/** DTPlatformName and CFBundleIdentifier of a build's Info.plist (empty when missing). */
export async function appInfo(exec: Exec, plutil: string, appPath: string): Promise<AppInfo> {
  const plist = join(appPath, 'Info.plist');
  const read = async (key: string) => {
    const r = await exec.run(plutil, ['-extract', key, 'raw', '-o', '-', plist], { timeoutMs: 15_000 });
    return r.code === 0 ? r.stdout.trim() : '';
  };
  return { platform: await read('DTPlatformName'), bundleId: await read('CFBundleIdentifier') };
}

/** Why a build cannot be filmed on the simulator, or null. Pure. */
export function appInfoProblem(info: AppInfo, path: string): string | null {
  if (!info.bundleId) return `app ${path} has no Info.plist with a CFBundleIdentifier: is it an app bundle (.app)?`;
  if (!IOS_BUNDLE_ID_RE.test(info.bundleId)) return `app ${path} has a CFBundleIdentifier that is no bundle id (letters, digits and "-" in dot-separated parts, each starting with a letter or a digit)`;
  if (info.platform !== 'iphonesimulator') {
    return `app ${path} is built for ${info.platform || 'an unknown platform'}, not for the iOS Simulator: build it with -sdk iphonesimulator (or the destination "generic/platform=iOS Simulator")`;
  }
  return null;
}

/** Install the build on the device (each take: the take films that build), or check an installed app is there. */
export async function installApp(simctl: Simctl, udid: string, app: RunApp): Promise<void> {
  if (app.path) {
    await simctl.terminate(udid, app.bundleId);
    await simctl.install(udid, app.path);
    return;
  }
  if (!(await simctl.installed(udid, app.bundleId))) {
    throw new Error(`app ${app.bundleId} is not installed on the run's simulator: give the path of its simulator build in project.yaml (ios.app) instead`);
  }
}
