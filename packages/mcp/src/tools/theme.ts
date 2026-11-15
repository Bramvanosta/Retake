/**
 * The theme tools: the engine's operations (template_list, template_preview, template_from_site,
 * template_create_from_brand and template_update are defined in packages/engine/src/operations/themes.ts), in tools/list's order.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { Op, ToolDef } from './define.js';

/** A site job as a tool shows it (template_from_site's, and job_status's for an extraction that outlived its wait). */
export { siteOutput } from '@retake/engine/contract';

const {
  template_list: templateList,
  template_preview: templatePreview,
  template_from_site: templateFromSite,
  template_create_from_brand: templateCreateFromBrand,
  template_update: templateUpdate,
} = OPERATIONS_BY_NAME;

export const THEME_TOOLS: readonly [Op<'template_list'>, Op<'template_preview'>, Op<'template_from_site'>, Op<'template_create_from_brand'>, Op<'template_update'>] = [
  templateList,
  templatePreview,
  templateFromSite,
  templateCreateFromBrand,
  templateUpdate,
] as const satisfies readonly ToolDef[];
