/**
 * The component tools (L3.2): the engine's operations (L7.17: component_list, component_get, component_validate,
 * component_preview and component_create are defined in packages/engine/src/operations/components.ts), in
 * tools/list's order.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { ToolDef } from './define.js';

const {
  component_list: componentList,
  component_get: componentGet,
  component_validate: componentValidate,
  component_preview: componentPreview,
  component_create: componentCreate,
} = OPERATIONS_BY_NAME;

export const COMPONENT_TOOLS = [componentList, componentGet, componentValidate, componentPreview, componentCreate] as const satisfies readonly ToolDef[];
