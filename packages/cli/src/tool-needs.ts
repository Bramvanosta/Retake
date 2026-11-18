/**
 * In the app, the commands that run a browser of Retake's (`browser`) or render (`render`: the render browser and the
 * compositor) in this process refuse before they start while those Tools are not downloaded (a terminal has no queue
 * to wait in; `retake tools install` downloads them). A command whose project launches a browser of its own
 * (`browser.executable`, an installed channel such as `chrome`) needs no Tool, and one on the headless shell needs the
 * render tools (core launchTool: the runner's launch rule, the queue's gate reads it too).
 */
import type { Command } from 'commander';
import { launchTool, toolNeedOf } from '@retake/core/io';
import type { ToolNeed } from '@retake/core/io';
import type { BrowserConfig } from '@retake/core/project';
import { toolsRefusal } from '@retake/engine/tools';
import type { ToolsWork } from '@retake/engine/tools';
import { openProject, openWorkspace } from './workspace.js';
import type { GlobalOptions } from './workspace.js';

type Opts = Record<string, unknown>;

/** What a command needs of the Tools, by its options (undefined: nothing for these options). */
export type CliToolNeed = ToolNeed | ((o: Opts) => ToolNeed | undefined);

/** The commands that need a Tool (each a command path of the program: tools.test.ts checks it). */
export const CLI_TOOL_NEEDS: Readonly<Record<string, CliToolNeed>> = {
  run: 'browser',
  login: 'browser',
  record: 'browser',
  inspect: 'browser',
  // The cursor atlas is drawn by a browser only for a cursor (none: data only).
  'export-capture': (o) => (o.cursor === 'none' ? undefined : 'browser'),
  'theme from-site': 'browser',
  // Checking the saved sessions opens each one headless; listing them opens nothing.
  'auth status': (o) => (o.check ? 'browser' : undefined),
  render: 'render',
  still: 'render',
  export: 'render',
  'components preview': 'render',
};

/** The commands whose first argument is a project whose `browser:` they launch, and whether that launch is headless. */
const PROJECT_LAUNCH: Readonly<Record<string, (o: Opts, b: BrowserConfig) => boolean>> = {
  run: (o, b) => (o.headed ? false : (b.headless ?? true)),
  login: (o) => o.auto === true,
  record: () => false,
  inspect: (_o, b) => b.headless ?? true,
  'export-capture': () => true,
};

/**
 * Why a launch of a project's browser (`b`, headless or not) may not start now (one sentence saying what to do), or
 * undefined: its Tool is ready, it needs none (a browser of the person's own), or this is a checkout.
 */
export function browserRefusal(w: ToolsWork, b: BrowserConfig | undefined, headless: boolean, what: string): string | undefined {
  const need = toolNeedOf(launchTool(b, headless));
  return need ? toolsRefusal(w, need, what) : undefined;
}

/** Why the command at `path` may not start now (CLI_TOOL_NEEDS), or undefined. `g`: the workspace (`-C`) and the ports. */
export async function commandRefusal(g: Pick<GlobalOptions, 'root' | 'ports'>, path: string, command: Command): Promise<string | undefined> {
  const w: ToolsWork = { env: g.ports.env, clock: g.ports.clock };
  const entry = CLI_TOOL_NEEDS[path];
  if (!entry) return undefined;
  const opts = command.opts<Opts>();
  const need = typeof entry === 'function' ? entry(opts) : entry;
  if (!need) return undefined;
  const what = `retake ${path}`;
  const refused = toolsRefusal(w, need, what);
  const headless = PROJECT_LAUNCH[path];
  const project = command.args[0];
  if (!refused || need !== 'browser' || !headless || typeof project !== 'string') return refused;
  // The browser is missing: does this project launch one of the Tools at all (its `browser:`, the workspace's folded
  // in)? A project that cannot be read keeps the refusal: the command would fail on it anyway.
  let b: BrowserConfig;
  try {
    b = (await openProject(await openWorkspace(g), project)).config.browser ?? {};
  } catch {
    return refused;
  }
  return browserRefusal(w, b, headless(opts, b), what);
}
