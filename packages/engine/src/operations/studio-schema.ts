/**
 * The input pieces of the Studio's operations and its read-only queries (the zod objects the Studio's published op
 * table is made from). Their words are the Studio's (they name its own ops: scenario_blocks lists the runs,
 * scenario_renders the renders), not the MCP pieces' of schema.ts; the Studio's other ops (ui/src/server/ops.ts) take
 * them from here too.
 */
import { z } from 'zod';
import { SLUG_RE } from '@retake/core/model';
import { zRenderId, zRunId } from '@retake/core/ids';
import { PROJECT_SLUG_RE } from '@retake/core/project';

export const studioProject = z.string().max(100).regex(PROJECT_SLUG_RE, 'a project slug (project_list names them), never a path');
export const studioScenario = z.string().max(100).regex(SLUG_RE, 'a scenario name (scenarios/<name>.yaml), never a path');
export const studioRun = zRunId('a run id (scenario_blocks lists them), never a path');
export const studioEnv = z.string().max(100).regex(SLUG_RE, 'an environment name of the project');
export const studioRenderId = zRenderId('a render id (scenario_renders lists them), never a path');
