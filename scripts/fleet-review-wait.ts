#!/usr/bin/env bun
/**
 * Report how long `fleet/review` jobs wait for a runner, measured on the JOB
 * (`job.started_at - run.created_at`), not the run — run-level timestamps read
 * 0m for every run and hid a 31-48 minute queue (#2648). Also lists queued runs
 * older than a day, which are stuck rather than queueing.
 *
 *   bun run scripts/fleet-review-wait.ts            # last 40 Fleet Review runs
 *   bun run scripts/fleet-review-wait.ts --limit 100
 *
 * Read-only: it cancels and deletes nothing.
 */
import { gh, describeGhFailure, REPO } from '../orchestrator/src/gh.js'
import { isZombie, runnerWait, summarizeWaits, type RunJobSample, type RunnerWait } from '../orchestrator/src/review-runner-wait.js'

interface RunRow { id: number; event: string; head_branch: string; created_at: string; status: string }
interface JobRow { name: string; status: string; started_at: string | null; runner_name: string | null }

async function main(): Promise<number> {
  const limitArg = process.argv.indexOf('--limit')
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 40
  if (!Number.isInteger(limit) || limit < 1) {
    console.error('--limit must be a positive integer')
    return 2
  }
  const now = new Date()
  let runs: RunRow[]
  try {
    const out = await gh(['api', `repos/${REPO}/actions/workflows/fleet-review.yml/runs?per_page=${Math.min(limit, 100)}`, '--jq', '.workflow_runs'])
    runs = JSON.parse(out) as RunRow[]
  } catch (e) {
    console.error(`could not list Fleet Review runs — ${describeGhFailure(e)}`)
    return 1
  }
  const waits: RunnerWait[] = []
  const zombies: RunRow[] = []
  let unreadable = 0
  for (const r of runs) {
    if (isZombie(r.created_at, r.status, now)) zombies.push(r)
    try {
      const out = await gh(['api', `repos/${REPO}/actions/runs/${r.id}/jobs`, '--jq', '.jobs'])
      const job = (JSON.parse(out) as JobRow[]).find((j) => j.name === 'fleet/review')
      if (job === undefined) continue
      const sample: RunJobSample = {
        runId: r.id, event: r.event, branch: r.head_branch, runCreatedAt: r.created_at,
        jobStartedAt: job.started_at, jobStatus: job.status, runnerName: job.runner_name,
      }
      const w = runnerWait(sample, now)
      if (w !== undefined) waits.push(w)
    } catch {
      unreadable += 1
    }
  }
  for (const w of waits) {
    console.log(`${String(w.waitMinutes).padStart(4)}m${w.stillWaiting ? '+' : ' '} ${w.event.padEnd(18)} run ${w.runId} ${w.branch}`)
  }
  const s = summarizeWaits(waits)
  console.log(`\n${s.runs} jobs, ${s.stillWaiting} still waiting (+); wait p50=${s.p50Minutes}m p90=${s.p90Minutes}m max=${s.maxMinutes}m`)
  for (const [event, e] of Object.entries(s.byEvent)) console.log(`  ${event}: ${e.runs} jobs, p50=${e.p50Minutes}m max=${e.maxMinutes}m`)
  if (unreadable > 0) console.log(`${unreadable} run(s) had unreadable job lists and are NOT in these numbers`)
  for (const z of zombies) console.log(`STUCK: run ${z.id} (${z.head_branch}) has been ${z.status} since ${z.created_at}`)
  return 0
}

process.exit(await main())
