/**
 * Compact results (L5.8, R-FLD-34): what review / review_get and page_inspect return by default — the findings, the
 * paths to read — and, with `detail: "full"`, everything as before. The field measured ≈ 15,000 tokens per
 * page_inspect and over 25,000 for a review (cut by the client). Nothing the summary says is dropped: the files keep the
 * rest (inspect.json, report.json). The `detail` argument and the compacts — the run status's (L7.13), the review's
 * (L7.14) and the inspection's (L7.15) — are the engine's operations' (@retake/engine/contract), re-exported here.
 *
 * Trust is unchanged: what the filmed site or the scenario wrote stays under `untrusted` (capUntrusted still applies).
 */
export { COMPACT_FINDINGS_MAX, COMPACT_MESSAGE_MAX, COMPACT_WARNINGS_MAX, compactElements, compactReview, compactRunStatus, detail } from '@retake/engine/contract';
export type { CompactElement, Detail } from '@retake/engine/contract';
