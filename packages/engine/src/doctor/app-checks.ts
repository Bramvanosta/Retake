/**
 * The installed app's lines of `retake doctor` (DESIGN §4p): the app bundle, where the app runs from, the `retake`
 * command's link, the app's update checks — and the two texts the lines show of paths and locks.
 */
import { dirname, join } from 'node:path';
import { HIDDEN_CHARS } from '@retake/core/base';
import { defaultRetakeHome } from '@retake/core/project';
import { retakeHome } from '@retake/core/io';
import { tildePath } from '../auth.js';
import {
  CLI_NAME,
  LAUNCHER_REL,
  MOVE_TO_APPLICATIONS,
  cliLinkState,
  cliOnPath,
  defaultCliDir,
  installLocation,
  installLocationWords,
  onReadOnlyVolume,
  readAppSettings,
  readUpdateChecks,
  updateChecksOff,
  UPDATE_DISABLE_ENV,
  zshQuote,
} from '../integrations.js';
import { readSmallFile } from './machine-probes.js';
import type { DoctorCheck, DoctorProbes } from './types.js';

/** A path for a command line to paste: `~/` kept outside, the rest single-quoted unless plain. */
export function pastePath(p: string): string {
  const t = tildePath(p);
  const plain = (s: string) => /^[A-Za-z0-9._/@%+,=-]+$/.test(s);
  if (t.startsWith('~/')) return `~/${plain(t.slice(2)) ? t.slice(2) : zshQuote(t.slice(2))}`;
  return plain(t) ? t : zshQuote(t);
}

/** A worker lock's text shown in this terminal: each hidden character (core hidden-chars.ts) as `?`, capped. */
export function lockText(s: string): string {
  return s.replace(new RegExp(`[${HIDDEN_CHARS}]`, 'gu'), '?').slice(0, 300);
}

/**
 * The `App updates` line: what the desktop app remembers of its checks (core readUpdateChecks). `build`: what the
 * app's launch.json says of its build (bundle.mjs `launchJson`: `updates` on / off; null for a build from before it) —
 * a build made without a feed and a key never checks.
 */
export function updateCheck(env: Record<string, string | undefined>, home: string, now: number, build: 'on' | 'off' | null = null): DoctorCheck {
  const name = 'App updates';
  if (build === 'off') return { status: 'ok', name, detail: 'updates are off in this build (made without an update feed): a newer version comes from its disk image' };
  let checks: ReturnType<typeof readUpdateChecks>;
  try {
    checks = readUpdateChecks(env.RETAKE_HOME?.trim() ? retakeHome(env as NodeJS.ProcessEnv) : defaultRetakeHome(home));
  } catch {
    checks = { checked: null, failed: null };
  }
  const off = updateChecksOff(env[UPDATE_DISABLE_ENV]) ? ` · ${UPDATE_DISABLE_ENV} is set here (the app started from this shell checks nothing)` : '';
  if (checks.failed && checks.failed.failure === 'install')
    return {
      status: 'warn',
      name,
      detail: `the update to ${checks.failed.version} could not be installed: the app kept this version${off}`,
      hint: 'open the app: Help › Check for Updates… tries again, or install the new version from its disk image',
    };
  if (checks.checked === null) return { status: 'ok', name, detail: `not checked yet — the app checks at launch, at most once a day (Help › Check for Updates…)${off}` };
  const when = new Date(checks.checked * 1000).toISOString().replace('T', ' ').slice(0, 16);
  const days = Math.floor((now / 1000 - checks.checked) / 86_400);
  return days > 30
    ? {
        status: 'warn',
        name,
        detail: `last successful check ${when} UTC, ${days} days ago${off}`,
        hint: 'open the app (it checks at launch), or Help › Check for Updates… — a feed that cannot be read says so there',
      }
    : { status: 'ok', name, detail: `last successful check ${when} UTC${off}` };
}

/** The app's location, its command and (an installed app) its update checks, seen at `now` (epoch ms). */
export function appChecks(p: DoctorProbes, now: number): DoctorCheck[] {
  const out = appCommandChecks(p);
  // An installed app's update checks — the last successful one, an install that failed, off.
  const home = p.env.HOME?.trim();
  if (p.bundle?.sealed.endsWith('.app') && home) out.push(updateCheck(p.env, home, now, launchUpdates((p.read ?? readSmallFile)(join(p.bundle.root, 'launch.json')))));
  return out;
}

/** launch.json's `updates` (bundle.mjs: "on" in a build with an update feed, "off" otherwise); null when absent. */
export function launchUpdates(text: string | null): 'on' | 'off' | null {
  try {
    const u = (JSON.parse(text ?? 'null') as { updates?: unknown } | null)?.updates;
    return u === 'on' || u === 'off' ? u : null;
  } catch {
    return null;
  }
}

/**
 * The installed app (DESIGN §4p (c)): where it runs from (a translocated copy, its disk image or
 * /Volumes — every path recorded then breaks) and the `retake` command's link (`<home>/app.json`'s, else
 * ~/.local/bin/retake): a link to an app that is gone, a file in its place that is not Retake's, another `retake` first
 * on this shell's PATH. From a repository checkout: only a dangling link is said.
 */
function appCommandChecks(p: DoctorProbes): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const b = p.bundle ?? null;
  const app = b?.sealed.endsWith('.app') ? b : null;
  if (app) {
    const loc = installLocation(app.sealed, { readOnly: (p.readOnly ?? onReadOnlyVolume)(app.sealed) });
    out.push(
      loc === 'ok'
        ? { status: 'ok', name: 'App location', detail: tildePath(app.sealed) }
        : {
            status: 'warn',
            name: 'App location',
            detail: `${installLocationWords(loc)} (${app.sealed}): the command and the Claude registrations would point into a folder that goes away`,
            hint: MOVE_TO_APPLICATIONS,
          },
    );
  }
  // The command's place is under the HOME of the probes' environment (a shell always has one).
  const home = p.env.HOME?.trim();
  if (!home) return out;
  let link = join(defaultCliDir(home), CLI_NAME);
  // The app's own record of where it put the link (a checkout reads nothing of the Retake home here).
  if (app) {
    try {
      link = readAppSettings(p.env.RETAKE_HOME?.trim() ? retakeHome(p.env as NodeJS.ProcessEnv) : defaultRetakeHome(home)).cli?.path ?? link;
    } catch {
      /* a RETAKE_HOME refused elsewhere: the default place */
    }
  }
  const launcher = app ? join(app.root, LAUNCHER_REL) : '';
  const st = cliLinkState(link, launcher);
  const name = 'retake command';
  const first = cliOnPath(dirname(link), p.env.PATH ?? '').first;
  const firstNote = first && first !== link ? ` · ${tildePath(first)} comes first on this PATH` : '';
  if (st.state === 'other_app' && st.dangling) {
    out.push({
      status: 'warn',
      name,
      detail: `${tildePath(link)} points to a Retake app that is gone (${st.target}): the command fails`,
      hint: `install it again from the app (Help › Install the retake Command…), or remove it: rm ${pastePath(link)}`,
    });
  } else if (!app) {
    return out;
  } else if (st.state === 'ours') {
    out.push(
      firstNote
        ? {
            status: 'warn',
            name,
            detail: `${tildePath(link)} → this app${firstNote}`,
            hint: `that one runs when you type retake: remove it, or put ${tildePath(dirname(link))} before it on your PATH`,
          }
        : { status: 'ok', name, detail: `${tildePath(link)} → this app` },
    );
  } else if (st.state === 'other_app') {
    out.push({ status: 'warn', name, detail: `${tildePath(link)} runs another copy of Retake (${st.target})`, hint: 'point it at this one: Help › Install the retake Command… (Replace)' });
  } else if (st.state === 'foreign') {
    out.push({
      status: 'warn',
      name,
      detail: `${tildePath(link)} is not Retake's command (${st.what}${st.target ? ` → ${st.target}` : ''}): the app leaves it as it is`,
      hint: 'remove or rename it yourself to install the command from the app, or choose another folder there',
    });
  } else {
    out.push({ status: 'ok', name, detail: `not installed${first ? ` (${tildePath(first)} is on this PATH)` : ''} · the app's Help › Install the retake Command… links it` });
  }
  return out;
}

/** What is wrong with the app bundle this engine runs from (a damaged manifest, playwright-core not loading): a FAIL, or no line. */
export function appBundleCheck(p: DoctorProbes): DoctorCheck | null {
  const damaged = p.bundleProblems?.() ?? [];
  return damaged.length ? { status: 'fail', name: 'App bundle', detail: damaged.join(' · '), hint: 'reinstall Retake' } : null;
}
