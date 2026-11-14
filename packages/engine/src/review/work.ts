/**
 * The pipeline's review (L7.11): a render reviewed into review/<render-id>/ on the reviewer its caller hands — the
 * CLI's `retake review` and `render --review` (cliPorts), a review job and a render job's inline review (their
 * composition root's). The reviewer's result and errors come back unchanged (the review package's ReviewError and
 * ReviewCancelledError on the product's).
 */
import type { ReviewOptions, ReviewResult } from '@retake/review/checks';
import type { Reviewer } from './reviewer.js';

/** Review a render into review/<render-id>/ (the reviewer's `review`). */
export function reviewWork(reviewer: Reviewer, o: ReviewOptions): Promise<ReviewResult> {
  return reviewer.review(o);
}
