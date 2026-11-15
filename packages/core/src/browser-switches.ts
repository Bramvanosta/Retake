/** The Chromium switches of agent-policy.ts: refused in `browser.args`, and the allow-list for a job an agent can shape. */
import { showHiddenChars } from './printable.js';

// ── Chromium switches ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Chromium switches (without their leading dashes) that turn the OS sandbox off for some or all of its child processes
 * (renderers, GPU, utilities), run them inside the unsandboxed browser process, or turn site isolation off. Always
 * refused in `browser.args`.
 */
export const SANDBOX_OFF_SWITCHES: readonly string[] = [
  'no-sandbox',
  'disable-setuid-sandbox',
  'disable-gpu-sandbox',
  'disable-namespace-sandbox',
  'disable-seccomp-filter-sandbox',
  'no-zygote',
  'no-zygote-sandbox',
  'single-process',
  'in-process-gpu',
  'disable-site-isolation-trials',
];

/**
 * The switches of SANDBOX_OFF_SWITCHES that act on Linux only (its setuid and namespace sandboxes, seccomp, the zygote):
 * on macOS Chromium has none of these, and a launcher that passes one (Remotion passes `--no-zygote`) leaves the
 * sandbox on. Still refused in `browser.args` everywhere.
 */
export const LINUX_ONLY_SANDBOX_SWITCHES: readonly string[] = ['disable-setuid-sandbox', 'disable-namespace-sandbox', 'disable-seccomp-filter-sandbox', 'no-zygote', 'no-zygote-sandbox'];

/**
 * Chromium switches (without their leading dashes) that open the browser to other code while its sandbox stays on: the
 * same-origin policy turned off, a program of the switch's choosing started in place of (or in front of) its child
 * processes, a debugging port any local program can drive. Always refused in `browser.args` (with SANDBOX_OFF_SWITCHES),
 * and a launched browser whose command line holds one is refused like an unsandboxed one.
 */
export const BROWSER_OPEN_SWITCHES: Readonly<Record<string, string>> = {
  'disable-web-security': "turns Chromium's same-origin policy off",
  'renderer-cmd-prefix': "starts Chromium's renderers through another program",
  'gpu-launcher': "starts Chromium's GPU process through another program",
  'utility-cmd-prefix': "starts Chromium's utility processes through another program",
  'browser-subprocess-path': "starts Chromium's child processes from another program",
  'remote-debugging-port': 'opens a debugging port any program of this machine can drive the browser through',
  'remote-debugging-address': 'opens a debugging port any program of this machine can drive the browser through',
};

/** Chromium features whose `--disable-features=` entry turns site isolation off (compared without case, `-` or `_`). */
export const SITE_ISOLATION_OFF_FEATURES: readonly string[] = ['IsolateOrigins', 'SitePerProcess'];

const featureKey = (name: string) => name.toLowerCase().replace(/[-_\s]/g, '');

/**
 * Why `arg` may not be passed to Chromium (null when it may): a switch of SANDBOX_OFF_SWITCHES or BROWSER_OPEN_SWITCHES,
 * or a `--disable-features=` list naming a feature of SITE_ISOLATION_OFF_FEATURES. Read as Chromium reads its command
 * line on macOS and Linux — `--name` or `-name`, a value after `=` — and more broadly (any case, spaces around it), so a
 * spelling Chromium would ignore is refused too.
 */
export function sandboxOffArgProblem(arg: string): string | null {
  const off = sandboxSwitchOff(arg);
  if (off) return off;
  const m = SWITCH.exec(arg);
  const name = m?.[1].toLowerCase();
  if (name && Object.hasOwn(BROWSER_OPEN_SWITCHES, name)) return `--${name} ${BROWSER_OPEN_SWITCHES[name]} — Retake's browsers never run with it: remove it from browser.args`;
  return null;
}

/** A switch as Chromium reads it on macOS and Linux, more broadly (any case, spaces around it): its name, its value. */
const SWITCH = /^\s*--?([^=\s]+)(?:=(.*))?$/s;
const SWITCH_FIX = 'every browser Retake launches runs sandboxed: remove it from browser.args';

/**
 * Why `arg` turns Chromium's OS sandbox or its site isolation off (null when it does not): a switch of
 * SANDBOX_OFF_SWITCHES, or a `--disable-features=` list naming a feature of SITE_ISOLATION_OFF_FEATURES — the narrower
 * reading of sandboxOffArgProblem, for a browser whose launcher passes other switches of its own (the render browser).
 * With `o.platform` other than linux, a switch of LINUX_ONLY_SANDBOX_SWITCHES does not (it has no effect there).
 */
export function sandboxSwitchOff(arg: string, o: { platform?: string } = {}): string | null {
  const m = SWITCH.exec(arg);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const fix = SWITCH_FIX;
  if (o.platform !== undefined && o.platform !== 'linux' && LINUX_ONLY_SANDBOX_SWITCHES.includes(name)) return null;
  if (SANDBOX_OFF_SWITCHES.includes(name)) {
    const what = name === 'disable-site-isolation-trials' ? "Chromium's site isolation" : "Chromium's sandbox";
    return `--${name} turns ${what} off — ${fix}`;
  }
  if (name === 'disable-features' && m[2] !== undefined) {
    const off = SITE_ISOLATION_OFF_FEATURES.map(featureKey);
    for (const entry of m[2].split(',')) {
      const feature = entry
        .replace(/[<:].*$/s, '')
        .replace(/^\s*\*?/, '')
        .trim();
      if (feature && off.includes(featureKey(feature))) return `--disable-features=${showHiddenChars(feature)} turns Chromium's site isolation off — ${fix}`;
    }
  }
  return null;
}

/** sandboxOffArgProblem for each argument of a list, with its index. */
export function sandboxOffArgsProblems(args: readonly string[]): Array<{ index: number; message: string }> {
  const out: Array<{ index: number; message: string }> = [];
  args.forEach((a, index) => {
    const message = typeof a === 'string' ? sandboxOffArgProblem(a) : null;
    if (message) out.push({ index, message });
  });
  return out;
}

/**
 * The Chromium switches (without their leading dashes) `browser.args` of a job an agent can shape (agent policy, below)
 * may hold, besides the always-refused ones (sandboxOffArgProblem): the window and the screen, the language, colours
 * and fonts, the GPU, timers and background work, first-run screens, media autoplay and fake capture devices, the
 * proxy and the host resolver, WebRTC and QUIC, features. Any other switch is refused — a list of what is safe rather
 * than of what is not, since Chromium has many switches that load code or a profile, write logs, dumps or traces where
 * they say, trust other certificates or open a page or a debugging channel. A command a person types keeps every
 * switch but the always-refused ones.
 */
export const AGENT_ALLOWED_SWITCHES: readonly string[] = [
  // window, screen, language
  'window-size',
  'window-position',
  'start-maximized',
  'hide-scrollbars',
  'force-device-scale-factor',
  'lang',
  'accept-lang',
  // colours, fonts, motion
  'force-color-profile',
  'force-dark-mode',
  'blink-settings',
  'force-prefers-reduced-motion',
  'force-prefers-no-reduced-motion',
  'font-render-hinting',
  'disable-font-subpixel-positioning',
  'disable-lcd-text',
  'disable-smooth-scrolling',
  // GPU and frames
  'use-gl',
  'use-angle',
  'disable-gpu',
  'disable-gpu-compositing',
  'enable-gpu-rasterization',
  'ignore-gpu-blocklist',
  'disable-frame-rate-limit',
  'disable-gpu-vsync',
  // timers and background work
  'disable-background-timer-throttling',
  'disable-backgrounding-occluded-windows',
  'disable-renderer-backgrounding',
  'disable-hang-monitor',
  'disable-ipc-flooding-protection',
  'disable-component-update',
  'disable-domain-reliability',
  'disable-sync',
  'disable-dev-shm-usage',
  // first-run screens, prompts
  'no-first-run',
  'no-default-browser-check',
  'disable-notifications',
  'disable-popup-blocking',
  'disable-prompt-on-repost',
  // media
  'autoplay-policy',
  'mute-audio',
  'use-fake-device-for-media-stream',
  // network
  'proxy-server',
  'proxy-bypass-list',
  'no-proxy-server',
  'host-resolver-rules',
  'webrtc-ip-handling-policy',
  'force-webrtc-ip-handling-policy',
  'disable-quic',
  // features
  'enable-features',
  'disable-features',
  'enable-blink-features',
  'disable-blink-features',
];

/**
 * Chromium features a job an agent can shape may not name in `--enable-features=` (`enable`) or `--disable-features=`
 * (`disable`) — the ones that move the network service out of its sandbox — besides SITE_ISOLATION_OFF_FEATURES
 * (always refused). Compared without case, `-` or `_`.
 */
export const AGENT_REFUSED_FEATURES: Readonly<{ enable: readonly string[]; disable: readonly string[] }> = {
  enable: ['NetworkServiceInProcess', 'NetworkServiceInProcess2'],
  disable: ['NetworkServiceSandbox'],
};

const AGENT_ARGS_FIX =
  'jobs the Studio, the desktop app or an MCP client start pass Chromium only the switches of a short list (see `browser.args` in the workspace guide): remove it from browser.args (a run typed in a terminal keeps it)';

/**
 * Why `arg` may not be passed to Chromium for a job an agent can shape (null when it may), besides
 * sandboxOffArgProblem: an argument that is not a switch (`--name` or `--name=value`; Chromium opens anything else as a
 * page or a file when it starts, and reads everything after `--` so), a switch that is not one of
 * AGENT_ALLOWED_SWITCHES, or a feature list naming one of AGENT_REFUSED_FEATURES.
 */
export function agentArgProblem(arg: string): string | null {
  const m = typeof arg === 'string' ? SWITCH.exec(arg) : null;
  const name = m?.[1].toLowerCase();
  if (!m || !name || name.startsWith('-')) {
    const shown = typeof arg === 'string' ? showHiddenChars(arg.length > 80 ? `${arg.slice(0, 77)}…` : arg) : String(arg);
    return `"${shown}" is not a switch (Chromium opens such an argument as a page or a file) — ${AGENT_ARGS_FIX}`;
  }
  if (!AGENT_ALLOWED_SWITCHES.includes(name)) {
    const shown = showHiddenChars(name.length > 60 ? `${name.slice(0, 57)}…` : name);
    return `--${shown} is not one of the switches these jobs may pass — ${AGENT_ARGS_FIX}`;
  }
  const side = name === 'enable-features' ? 'enable' : name === 'disable-features' ? 'disable' : null;
  if (side && m[2] !== undefined) {
    const refused = AGENT_REFUSED_FEATURES[side].map(featureKey);
    for (const entry of m[2].split(',')) {
      const feature = entry
        .replace(/[<:].*$/s, '')
        .replace(/^\s*\*?/, '')
        .trim();
      if (feature && refused.includes(featureKey(feature))) return `--${name}=${showHiddenChars(feature)} takes Chromium's network service out of its sandbox — ${AGENT_ARGS_FIX}`;
    }
  }
  return null;
}

/** agentArgProblem for each argument of a list, with its index. */
export function agentArgsProblems(args: readonly string[]): Array<{ index: number; message: string }> {
  const out: Array<{ index: number; message: string }> = [];
  args.forEach((a, index) => {
    const message = agentArgProblem(a);
    if (message) out.push({ index, message });
  });
  return out;
}
