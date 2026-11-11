/** The kit's configuration (types.ts `KitConfig`). */
import type { KitConfig } from '../types.js';

/** Defined by the function the page script runs in (source.ts `kitSource`): one configuration per evaluation. */
declare const __retakeKitConfig: KitConfig;

export const config: KitConfig = __retakeKitConfig;
