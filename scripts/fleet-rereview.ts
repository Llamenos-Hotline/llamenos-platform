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
import { gh, describeGhFailure, REPO } from '../orchestrator/src/gh.js'
import { REVIEW_RERUN_WORKFLOW } from '../orchestrator/src/ci.js'
import { rerunReview, type RerunDeps, type RerunRun } from '../orchestrator/src/review-rerun.js'

const deps: RerunDeps = {
  async readPr(pr) {
    const j = JSON.parse(await gh(['pr', 'view', String(pr), '-R', REPO, '--json', 'number,headRefOid,headRefName,author,reviewRequests'])) as {
      number: number; headRefOid: string; headRefName: string; author: { login: string }
      reviewRequests: Array<{ login?: string }>
    }
    return {
      number: j.number, headSha: j.headRefOid, branch: j.headRefName, author: j.author.login,
      requestedReviewers: j.reviewRequests.flatMap((r) => (r.login === undefined ? [] : [r.login])),
    }
  },
  async reviewRequestEvents(pr, login) {
    const out = await gh([
      'api', '--paginate', `repos/${REPO}/issues/${pr}/events?per_page=100`, '--jq',
      `.[] | select(.event=="review_requested" and (.requested_reviewer.login|ascii_downcase)=="${login.toLowerCase()}") | .created_at`,
    ])
    return out.split('\n').filter((l) => l.length > 0)
  },
  async removeReviewer(pr, login) {
    await gh(['api', '-X', 'DELETE', `repos/${REPO}/pulls/${pr}/requested_reviewers`, '-f', `reviewers[]=${login}`, '--silent'])
  },
  async addReviewer(pr, login) {
    await gh(['api', '-X', 'POST', `repos/${REPO}/pulls/${pr}/requested_reviewers`, '-f', `reviewers[]=${login}`, '--silent'])
  },
  async rerunRuns(headSha) {
    const out = await gh([
      'api', `repos/${REPO}/actions/workflows/${REVIEW_RERUN_WORKFLOW}/runs?event=pull_request&head_sha=${headSha}&per_page=20`,
      '--jq', '.workflow_runs',
    ])
    return JSON.parse(out) as RerunRun[]
  },
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

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
