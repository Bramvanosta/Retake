/**
 * L6.13: The desktop app's own ops: the quit question's answer, the update, the Set-up sheet, the tabs' unsaved
 * reports. Each op once, typed by StudioOps (data/ops.ts).
 */
import { op } from './client.js';

export const desktopAnswer = op('desktop_answer');
export const desktopUpdateStatus = op('desktop_update_status');
export const desktopUpdate = op('desktop_update');
export const setupStatus = op('setup_status');
export const setupDone = op('setup_done');
export const setupCliInstall = op('setup_cli_install');
export const setupCliChoose = op('setup_cli_choose');
export const setupCliRemove = op('setup_cli_remove');
export const setupClaudeCodeRun = op('setup_claude_code_run');
export const setupClaudeDesktopAdd = op('setup_claude_desktop_add');
export const setupNotifications = op('setup_notifications');
export const unsavedReport = op('unsaved_report');
