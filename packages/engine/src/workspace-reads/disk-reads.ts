/**
 * The product's adapter of the WorkspaceReads port (reads.ts): core's loaders on node:fs. Named only here and in
 * ports.ts `enginePorts` (the import-rules ratchet's `workspace-read` check).
 */
import { nodeWorkspaceReader } from '@retake/core/io';
import type { WorkspaceReads } from './reads.js';

/** core io nodeWorkspaceReader: the loaders' public names, the checks' fileFacts(policy). */
export const diskWorkspaceReads: WorkspaceReads = nodeWorkspaceReader;
