/**
 * The ports of the Studio server's own work before its engine is made (the composition package's productPorts: the product's adapters):
 * what it reads the workspace's configuration through — the folders its worker's environment is cleaned of, and the
 * folders the Studio's token must lie outside. The Studio server's one composition root of them (the import-rules
 * ratchet's `workspace-read` check reads packages/ui/src/server): a module names `studioPorts`, never the adapters.
 */
import { productPorts } from '@retake/compose';
import type { EnginePorts } from '@retake/engine';

export const studioPorts: EnginePorts = productPorts();
