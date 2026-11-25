#!/usr/bin/env bun
/**
 * migration-base.ts — the commit the migration gates judge this run against (#3023).
 *
 * `migration:safety`, `migration:claims` and `migration:order` all ask "what
 * does this tree add on top of <base>?", so the base must be a commit the
 * checked-out tree DESCENDS from, with the change under test as the only
 * difference. Each event supplies that commit differently:
 *
 *   pull_request       base.sha. actions/checkout checks out the PR's merge
 *                      ref, which is base.sha + the PR.
 *   merge_group        merge_group.base_sha: the group's head is that commit +
 *                      the entries in the group.
 *   push               `before`, the tip this push moved the branch from. On a
 *                      branch's FIRST push `before` is all zeros (there was no
 *                      tip), and it is treated like workflow_dispatch.
 *   workflow_dispatch  No payload names a base, and the tree is the branch head
 *                      as-is, NOT merged with anything. So the base is the
 *                      merge-base of HEAD with the default branch: the commit
 *                      the branch forked from, which makes the branch's own
 *                      commits the change under test, exactly as base.sha + PR
 *                      is on pull_request. On the default branch itself the
 *                      merge-base is HEAD, which adds nothing to judge (the
 *                      schema drift check, which needs no base, still runs).
 *
 * The default branch's TIP would be the wrong base for a dispatched branch that
 * main has moved past: every migration main gained since the fork would read
 * as one this branch deleted, and `migration:order` cannot place a base HEAD
 * does not descend from. A collision with those newer migrations is
 * `migration:claims`' job on the PR's merge ref and in the merge group.
 *
 * Exit 0 prints the base (and appends MIGRATION_BASE=<sha> to $GITHUB_ENV when
 * set). Exit 2 is "could not resolve one", which ci-run-gate.sh labels DID NOT
 * RUN. There is no fallback: an empty base used to reach the gates, where one
 * rejected it and the others quietly judged against a default instead.
 *
 * Inputs (environment, set by the workflow from the event payload):
 *   EVENT_NAME, PR_BASE_SHA, MERGE_GROUP_BASE_SHA, PUSH_BEFORE, DEFAULT_BRANCH
 */
import { appendFileSync } from 'node:fs'
import { ensureMergeBase, type GitRunner, spawnGit } from '../lib/git-ancestry'

export interface BaseInputs {
  event: string
  prBase?: string
  groupBase?: string
  pushBefore?: string
  defaultBranch?: string
}

export type BaseDecision =
  | { kind: 'given'; base: string; why: string }
  | { kind: 'merge-base'; branch: string; why: string }

const SHA = /^[0-9a-f]{40}$/
const NULL_SHA = /^0{40}$/

/** Thrown when the event cannot yield a base; main() turns it into exit 2. */
export class NoBase extends Error {}

function given(value: string | undefined, field: string, event: string): BaseDecision {
  const v = value?.trim() ?? ''
  if (!SHA.test(v)) throw new NoBase(`${event}: ${field} is ${v === '' ? 'empty' : `not a commit sha (${v})`}`)
  return { kind: 'given', base: v, why: `${event}: ${field}` }
}

function mergeBaseWith(defaultBranch: string | undefined, why: string): BaseDecision {
  const branch = defaultBranch?.trim() ?? ''
  if (branch === '') throw new NoBase(`${why}, but DEFAULT_BRANCH is empty`)
  return { kind: 'merge-base', branch, why: `${why}: merge-base of HEAD with ${branch}` }
}

/** Which commit the event names as the base, or which branch to fork-point against. Pure. */
export function decideBase(i: BaseInputs): BaseDecision {
  switch (i.event) {
    case 'pull_request':
      return given(i.prBase, 'pull_request.base.sha', i.event)
    case 'merge_group':
      return given(i.groupBase, 'merge_group.base_sha', i.event)
    case 'push':
      if (NULL_SHA.test(i.pushBefore?.trim() ?? '')) {
        return mergeBaseWith(i.defaultBranch, 'push: first push of this branch (before is all zeros)')
      }
      return given(i.pushBefore, 'before', i.event)
    case 'workflow_dispatch':
      return mergeBaseWith(i.defaultBranch, 'workflow_dispatch: no base in the payload')
    default:
      throw new NoBase(`event "${i.event}" has no defined migration base`)
  }
}

/** Resolve a decision to a commit sha, fetching what the shallow checkout lacks. */
export function resolveBase(git: GitRunner, d: BaseDecision): { base: string; log: string } {
  if (d.kind === 'given') return { base: d.base, log: d.why }
  const r = ensureMergeBase(git, d.branch)
  const fetched = r.steps.join(' -> ') || 'nothing'
  if (r.mergeBase === null) {
    throw new NoBase(
      `${d.why}: HEAD shares no history with ${d.branch} (${r.target.slice(0, 12)}) even with the full history ` +
        `fetched (${fetched}), so there is no commit to judge its migrations against.`,
    )
  }
  return { base: r.mergeBase, log: `${d.why} (tip ${r.target.slice(0, 12)}; fetched: ${fetched})` }
}

if (import.meta.main) {
  const env = process.env
  try {
    const decision = decideBase({
      event: env.EVENT_NAME ?? '',
      prBase: env.PR_BASE_SHA,
      groupBase: env.MERGE_GROUP_BASE_SHA,
      pushBefore: env.PUSH_BEFORE,
      defaultBranch: env.DEFAULT_BRANCH,
    })
    const { base, log } = resolveBase(spawnGit(process.cwd()), decision)
    console.error(`[migration-base] ${base} — ${log}`)
    if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `MIGRATION_BASE=${base}\n`)
    console.log(base)
  } catch (e) {
    console.error(`[migration-base] could not resolve a base: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }
}
