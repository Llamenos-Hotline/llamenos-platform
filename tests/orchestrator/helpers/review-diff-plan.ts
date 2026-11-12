import { compactReviewDiff } from '../../../orchestrator/src/review.js'
import { planReviewDiff, type ReviewDiffPlan } from '../../../orchestrator/src/review-diff.js'

/**
 * A diff laid out as the parts a reviewer is told to read (#2726), WITHOUT
 * writing them: the same `compactReviewDiff` + `planReviewDiff` pair
 * `invokeVerifierEngine` runs, under a fixed fake directory. For prompt
 * builder tests, which take a plan now that the diff is not inlined.
 */
export function planFor(diff: string, headDir?: string, baseDir?: string): ReviewDiffPlan {
  return planReviewDiff(compactReviewDiff(diff, headDir, baseDir), '/review-diff-parts')
}

/** Every diff part's content, in reading order — with the brief, this is
 *  everything a reviewer is shown. */
export function partsText(plan: ReviewDiffPlan): string {
  return plan.parts.map((p) => p.text).join('\n')
}
