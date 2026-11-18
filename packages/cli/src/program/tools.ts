import { toolsCheckCommand, toolsInstallCommand, toolsPruneCommand, toolsStatusCommand } from '../commands/tools.js';
import type { ToolsCheckOptions, ToolsInstallOptions, ToolsPruneOptions, ToolsStatusOptions } from '../commands/tools.js';
import type { ProgramContext } from './context.js';

/** The app's downloaded Tools: status, install, check, prune. */
export function registerToolsCommands({ program, action }: ProgramContext): void {
  const tools = program.command('tools').description("the app's downloaded Tools — the browser, the render browser and the compositor — in the Retake home ($RETAKE_HOME, else ~/.retake)");
  tools
    .command('status', { isDefault: true })
    .description('each Tool: its version, whether it is downloaded and checked, its folder; older folders')
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: ToolsStatusOptions) => toolsStatusCommand(u, g, o)));
  tools
    .command('install')
    .description('download the Tools from their publishers, check each archive (sha256) and each folder (tree digest), and put them in place; Ctrl-C pauses (what arrived is kept)')
    .option('--from-archives <dir>', 'install from the archives in this folder (or one folder below) instead of downloading them: the same checks')
    .option('--from-playwright-cache [dir]', "copy the browsers from Playwright's cache (default $PLAYWRIGHT_BROWSERS_PATH, else its macOS folder), each copy checked")
    .option('--no-wait', 'while another process downloads them, say who and exit instead of following it')
    .option('--json', 'machine-readable output: one JSON line per progress step, then the result')
    .action(action((u, g, o: ToolsInstallOptions) => toolsInstallCommand(u, g, o)));
  tools
    .command('check')
    .description("check every downloaded Tool's folder again, file by file (its tree digest): a changed one is marked damaged until it is installed again")
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: ToolsCheckOptions) => toolsCheckCommand(u, g, o)));
  tools
    .command('prune')
    .description(
      "remove older Tools folders: not this version's, not those another copy of Retake started with in the last 30 days, an update downloaded in the last 30 days, or a running process uses",
    )
    .option('--force', "keep only this version's Tools (an update's pre-downloaded ones go too: it downloads them at its first start)")
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: ToolsPruneOptions) => toolsPruneCommand(u, g, o)));
}
