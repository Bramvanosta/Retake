/** Workspace and project loading: moved into @retake/engine (L3.1), shared with the MCP server. */
export { openWorkspace, openProject } from '@retake/engine';

export interface GlobalOptions {
  /** Workspace root (overrides $RETAKE_ROOT and the retake.yaml lookup). */
  root?: string;
  verbose?: boolean;
  color?: boolean;
}
