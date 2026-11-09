/**
 * L6.13: The Record screen: the recording's options, start, view, annotations, stop, discard and save. Each op once,
 * typed by StudioOps (data/ops.ts).
 */
import { op, readHook } from './client.js';

export const recordOptions = op('record_options');
export const useRecordOptions = readHook('record_options');
export const recordStart = op('record_start');
export const recordView = op('record_view');
export const recordAnnotate = op('record_annotate');
export const recordStop = op('record_stop');
export const recordDiscard = op('record_discard');
export const recordSave = op('record_save');
