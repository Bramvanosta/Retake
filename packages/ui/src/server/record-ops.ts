/**
 * The Studio's Record screen ops (R-UI-20 / 21 / 22): record_options, record_start, record_view,
 * record_annotate, record_stop, record_discard, record_save. They are the engine's operations
 * (packages/engine/src/operations/record.ts: their pinned inputs, path-free answers, the Record screen's caller rule
 * and their keys on the engine's operation chain); the Studio serves them as they are (studio.ts uiTools). Here: their
 * names, and the answers and helpers the app and the tests name.
 */
export { recordPathFree, recordViewAnswer } from '@retake/engine/contract';
export type { RecordEnvironmentOption, RecordOptionsAnswer, RecordPersonaOption, RecordStartAnswer, RecordViewAnswer } from '@retake/engine/contract';

export const RECORD_OPS = ['record_options', 'record_start', 'record_view', 'record_annotate', 'record_stop', 'record_discard', 'record_save'] as const;
