#!/usr/bin/env bun
/**
 * Re-request the fleet review on a PR and CONFIRM A RUN STARTED (#3058).
 *
 *   bun run scripts/fleet-rereview.ts <pr>
 *
 * Exit 0 only when a run of fleet-review-re-evaluate.yml exists on the PR's
 * head SHA, created after the request. A request that emitted no event, or an
 * event that started no run, exits 1 and says which. The logic and its tests
 * live in orchestrator/src/review-rerun.ts; this file is only the `gh` wiring.
 *
 * Acts as whichever `gh` identity is active: it must be one GitHub accepts as
 * a requester (not the PR's author).
 */
import { describeGhFailure } from '../orchestrator/src/gh.js'
import { REVIEW_RERUN_WORKFLOW } from '../orchestrator/src/ci.js'
import { rerunReview } from '../orchestrator/src/review-rerun.js'
import { liveRerunDeps } from '../orchestrator/src/review-unstick.js'

// The live deps are shared with the fleet's own review-unstick pass (#3113),
// comment-review recovery included: when the plain request emits no event
// (a pending CODEOWNER request), a COMMENT review is submitted as the
// reviewer from the operator's keyring and the request is re-added.
const deps = liveRerunDeps((msg) => console.error(msg))

const pr = Number(process.argv[2])
if (!Number.isInteger(pr) || pr < 1) {
  console.error('usage: bun run scripts/fleet-rereview.ts <pr>')
  process.exit(2)
}
try {
  const result = await rerunReview(deps, pr)
  if (!result.ok) {
    console.error(`#${pr}: ${result.reason}`)
    process.exit(1)
  }
  console.log(`#${pr}: ${REVIEW_RERUN_WORKFLOW} run ${result.run.id} started on the head — ${result.run.html_url}`)
} catch (e) {
  console.error(`#${pr}: could not complete the re-request — ${describeGhFailure(e)}`)
  process.exit(1)
}
