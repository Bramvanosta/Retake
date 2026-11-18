/** The app's downloaded Tools (ui tools-ops.ts): their ops, each once (the shared status: tools-data.ts). */
import { op } from './client.js';

export const toolsStatus = op('tools_status');
export const toolsInstall = op('tools_install');
export const toolsControl = op('tools_control');
export const toolsCheck = op('tools_check');
export const toolsPrune = op('tools_prune');
export const toolsReveal = op('tools_reveal');
