/**
 * The theme tools (L3.5): the engine's operations (L7.17: template_list, template_preview, template_from_site and
 * template_create_from_brand are defined in packages/engine/src/operations/themes.ts), in tools/list's order.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { ToolDef } from './define.js';

/** A site job as a tool shows it (template_from_site's, and job_status's for an extraction that outlived its wait). */
export { siteOutput } from '@retake/engine/contract';

const { template_list: templateList, template_preview: templatePreview, template_from_site: templateFromSite, template_create_from_brand: templateCreateFromBrand } = OPERATIONS_BY_NAME;

export const THEME_TOOLS = [templateList, templatePreview, templateFromSite, templateCreateFromBrand] as const satisfies readonly ToolDef[];
