/**
 * L6.13: Edit: the timeline's view, its preview leases and the preview's allow-list. Each op once, typed by StudioOps
 * (data/ops.ts).
 */
import { op, readHook } from './client.js';

export const useTimelineView = readHook('timeline_view');
export const timelineLeave = op('timeline_leave');
export const previewAllow = op('preview_allow');
