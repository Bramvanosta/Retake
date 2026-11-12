/**
 * The delivery formats of an export (L3.2; in jobs.ts until L7.35, when the job vocabulary went to the engine): the names
 * an export job takes and the editor's EXPORT_FORMATS table is keyed by.
 */
export const EXPORT_FORMAT_NAMES = ['mp4_1080p', 'mp4_4k', 'webm', 'vertical_9x16', 'square_1x1', 'gif_preview'] as const;

/** The formats of an export that names none: the ones derived from the master (no re-render) — the editor's and the jobs'. */
export const DEFAULT_EXPORT_FORMAT_NAMES: readonly ExportFormatName[] = ['mp4_1080p', 'webm', 'gif_preview'];

export type ExportFormatName = (typeof EXPORT_FORMAT_NAMES)[number];
