/** Workspace and project loading: moved into @demo-studio/engine (L3.1), shared with the MCP server. */
export { openWorkspace, openProject } from '@demo-studio/engine';

export interface GlobalOptions {
  /** Workspace root (overrides $DEMO_STUDIO_ROOT and the studio.yaml lookup). */
  root?: string;
  verbose?: boolean;
  color?: boolean;
}
