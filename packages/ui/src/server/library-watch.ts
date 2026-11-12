/**
 * What the Studio's library and theme screens watch (L4.7, critique B5): the engine's stat walks (L7.17: moved into
 * @retake/engine with library_view, whose memo reads them; see packages/engine/src/library-watch.ts). The event stream
 * (live.ts) diffs them each poll and says which themes / namespaces changed, and that an extraction appeared.
 */
export { WATCH_DEPTH_MAX, WATCH_ENTRIES_MAX, WATCH_FOLDERS_MAX, WATCH_SCAN_BUDGET, componentNamespaceSignatures, libraryChanges, libraryWatchScan, siteSignature, themeSignatures, treeSignature, watchBudget } from '@retake/engine';
export type { WatchBudget } from '@retake/engine';
