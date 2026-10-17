import { describe, it, expect, vi } from 'vitest'
import {
  runReviewLoop, MAX_REVIEW_ROUNDS, VerifierTamperedWorktreeError,
  type ReviewLoopDeps, type ReviewLoopInput, type SecondOpinionResult,
} from '../../orchestrator/src/review.js'
import type { Lane } from '../../orchestrator/src/config.js'
import type { VerifyReport } from '../../orchestrator/src/verify.js'

const lane: Lane = {
  id: 'backend', mode: 'live', cap: 1, engine: 'claude',
  requireLabel: 'agent-dispatchable', vetoLabels: ['needs-human'],
  scope: { owned: ['apps/backend/'], notOwned: [] },
}

const input: ReviewLoopInput = {
  authorEngine: 'claude', pr: '42', worktree: '/tmp/wt', branch: 'fleet/backend/1', lane,
}

const passingReport = (): VerifyReport => ({
  passed: true, reasons: [], changedFiles: [], addedLines: 0,
  impact: 'low', impactReasons: [], testsPassed: true, verifiedCommit: 'deadbeef',
})

const failingReport = (): VerifyReport => ({
  passed: false, reasons: ['scope violation'], changedFiles: [], addedLines: 0,
  impact: 'low', impactReasons: [], testsPassed: true, verifiedCommit: undefined,
})

function deps(over: Partial<ReviewLoopDeps> = {}): ReviewLoopDeps {
  return {
    verifyMechanical: vi.fn(async () => passingReport()),
    prDiff: vi.fn(async () => 'diff'),
    secondOpinion: vi.fn(async (): Promise<SecondOpinionResult> => ({ verdict: 'PASS', text: 'VERDICT: PASS' })),
    postReview: vi.fn(async () => {}),
    commentOnPr: vi.fn(async () => {}),
    reviseWithWorker: vi.fn(async () => {}),
    haltFleet: vi.fn(),
    log: () => {},
    ...over,
  }
}

describe('runReviewLoop', () => {
  it('forwards allLanes to verifyMechanical so a scope refusal can name its remedy', async () => {
    const d = deps()
    const allLanes: Lane[] = [lane, { ...lane, id: 'infra' }]
    await runReviewLoop({ ...input, allLanes }, d)

    expect(d.verifyMechanical).toHaveBeenCalledWith(
      expect.objectContaining({ allLanes }),
    )
  })

  it('a PASS on round one runs no second round', async () => {
    const d = deps()
    const result = await runReviewLoop(input, d)

    expect(result).toEqual({
      finalVerdict: 'PASS', rounds: 1, needsHuman: false, lastReport: passingReport(), lastVerdictText: 'VERDICT: PASS',
    })
    expect(d.verifyMechanical).toHaveBeenCalledTimes(1)
    expect(d.secondOpinion).toHaveBeenCalledTimes(1)
    expect(d.postReview).toHaveBeenCalledTimes(1)
    expect(d.postReview).toHaveBeenCalledWith('42', 'PASS', expect.any(String))
    expect(d.reviseWithWorker).not.toHaveBeenCalled()
    // A PASS is a real review — no "review unavailable" comment is needed.
    expect(d.commentOnPr).not.toHaveBeenCalled()
  })

  it('a FAIL then a PASS reports two rounds', async () => {
    const secondOpinion = vi.fn<ReviewLoopDeps['secondOpinion']>()
      .mockResolvedValueOnce({ verdict: 'FAIL', text: 'VERDICT: FAIL — nope' })
      .mockResolvedValueOnce({ verdict: 'PASS', text: 'VERDICT: PASS' })
    const d = deps({ secondOpinion })

    const result = await runReviewLoop(input, d)

    expect(result.finalVerdict).toBe('PASS')
    expect(result.rounds).toBe(2)
    expect(result.needsHuman).toBe(false)
    expect(d.verifyMechanical).toHaveBeenCalledTimes(2) // re-verified on round two
    expect(secondOpinion).toHaveBeenCalledTimes(2)
    expect(d.reviseWithWorker).toHaveBeenCalledTimes(1)
    expect(d.reviseWithWorker).toHaveBeenCalledWith({ verdictText: 'VERDICT: FAIL — nope' })
  })

  it('two FAILs stop the loop and hand the item to a human', async () => {
    const secondOpinion = vi.fn<ReviewLoopDeps['secondOpinion']>()
      .mockResolvedValue({ verdict: 'FAIL', text: 'VERDICT: FAIL — still nope' })
    const d = deps({ secondOpinion })

    const result = await runReviewLoop(input, d)

    expect(result.finalVerdict).toBe('FAIL')
    expect(result.rounds).toBe(2)
    expect(result.needsHuman).toBe(true)
    // Revision is only useful ahead of a round that will actually happen —
    // there is no round 3, so revising after round 2's FAIL would be pure
    // waste. Exactly one revision, between rounds 1 and 2.
    expect(d.reviseWithWorker).toHaveBeenCalledTimes(1)
  })

  // The load-bearing mutation-guard test: a reviewer stubbed to ALWAYS FAIL
  // must never push the loop past MAX_REVIEW_ROUNDS. An off-by-one (`<=`
  // instead of `<` on the revise guard, or a loop bound one too high) would
  // still pass the "two FAILs" test above by coincidence if it happened to
  // stop at exactly two anyway; asserting the exact call counts here is
  // what catches a loop that would keep going a third, fourth, fifth round
  // against a reviewer that never changes its mind — burning a worker's
  // budget and the fleet's rate limit at the same time.
  it('the round counter cannot exceed two even with a reviewer stubbed to always FAIL', async () => {
    const secondOpinion = vi.fn<ReviewLoopDeps['secondOpinion']>()
      .mockResolvedValue({ verdict: 'FAIL', text: 'VERDICT: FAIL — always' })
    const d = deps({ secondOpinion })

    const result = await runReviewLoop(input, d)

    expect(result.rounds).toBe(MAX_REVIEW_ROUNDS)
    expect(result.rounds).toBeLessThanOrEqual(2)
    expect(secondOpinion).toHaveBeenCalledTimes(MAX_REVIEW_ROUNDS)
    expect(d.verifyMechanical).toHaveBeenCalledTimes(MAX_REVIEW_ROUNDS)
    expect(d.reviseWithWorker).toHaveBeenCalledTimes(MAX_REVIEW_ROUNDS - 1)
  })

  it('a mechanical failure ends the loop immediately, without ever requesting a review', async () => {
    const d = deps({ verifyMechanical: vi.fn(async () => failingReport()) })

    const result = await runReviewLoop(input, d)

    expect(result.finalVerdict).toBe('FAIL')
    expect(result.rounds).toBe(1)
    expect(result.needsHuman).toBe(true)
    expect(d.secondOpinion).not.toHaveBeenCalled()
    expect(d.reviseWithWorker).not.toHaveBeenCalled()
  })

  // Trust failure, not a review outcome: a verifier that tampers with the
  // author's own worktree must never be retried, and must trip the kill
  // switch fleet-wide rather than being treated as one more FAIL round.
  it('a verifier that tampers with the worktree trips the kill switch and is never retried', async () => {
    const secondOpinion = vi.fn(async () => {
      throw new VerifierTamperedWorktreeError('HEAD moved during review')
    })
    const haltFleet = vi.fn()
    const d = deps({ secondOpinion, haltFleet })

    const result = await runReviewLoop(input, d)

    expect(result.needsHuman).toBe(true)
    expect(result.rounds).toBe(1)
    expect(haltFleet).toHaveBeenCalledTimes(1)
    expect(haltFleet.mock.calls[0]?.[0]).toContain('42')
    // Not retried: exactly one attempt, no revision, no second mechanical
    // verify, and no review posted for a verdict that cannot be trusted.
    expect(secondOpinion).toHaveBeenCalledTimes(1)
    expect(d.reviseWithWorker).not.toHaveBeenCalled()
    expect(d.verifyMechanical).toHaveBeenCalledTimes(1)
    expect(d.postReview).not.toHaveBeenCalled()
  })

  it('propagates an ordinary (non-tamper) error from secondOpinion rather than swallowing it', async () => {
    const secondOpinion = vi.fn(async () => { throw new Error('network down') })
    const d = deps({ secondOpinion })

    await expect(runReviewLoop(input, d)).rejects.toThrow('network down')
    expect(d.haltFleet).not.toHaveBeenCalled()
  })

  // G3: the fix for issue #660/PR #662's silent gap — a human reading an
  // UNREADABLE-reviewed PR must be told explicitly that they are the only
  // review it has had, not left to infer it from a terse review body.
  describe('G3: "review unavailable" comment', () => {
    it('posts an explicit comment on an UNREADABLE verdict from secondOpinion, in addition to the review', async () => {
      const secondOpinion = vi.fn<ReviewLoopDeps['secondOpinion']>()
        .mockResolvedValue({ verdict: 'UNREADABLE', text: '(reviewer engine was unreachable)' })
      const d = deps({ secondOpinion })

      const result = await runReviewLoop(input, d)

      expect(result.finalVerdict).toBe('UNREADABLE')
      expect(result.lastVerdictText).toBe('(reviewer engine was unreachable)')
      expect(d.postReview).toHaveBeenCalledWith('42', 'UNREADABLE', expect.any(String))
      expect(d.commentOnPr).toHaveBeenCalledWith('42', expect.stringContaining('(reviewer engine was unreachable)'))
      expect(d.commentOnPr).toHaveBeenCalledWith('42', expect.stringContaining('only review'))
    })

    it('posts the comment on a tamper-halted loop even though postReview was never reached', async () => {
      const secondOpinion = vi.fn(async () => { throw new VerifierTamperedWorktreeError('HEAD moved during review') })
      const d = deps({ secondOpinion })

      const result = await runReviewLoop(input, d)

      expect(result.finalVerdict).toBe('UNREADABLE')
      expect(d.postReview).not.toHaveBeenCalled()
      expect(d.commentOnPr).toHaveBeenCalledTimes(1)
      expect(d.commentOnPr).toHaveBeenCalledWith('42', expect.stringContaining('tampered'))
    })

    it('does NOT post the comment for an ordinary FAIL — a real review already happened', async () => {
      const secondOpinion = vi.fn<ReviewLoopDeps['secondOpinion']>()
        .mockResolvedValue({ verdict: 'FAIL', text: 'VERDICT: FAIL — nope' })
      const d = deps({ secondOpinion })

      await runReviewLoop(input, d)

      expect(d.commentOnPr).not.toHaveBeenCalled()
    })

    it('a comment failure is logged and swallowed — it must not overwrite the already-decided verdict', async () => {
      const secondOpinion = vi.fn<ReviewLoopDeps['secondOpinion']>()
        .mockResolvedValue({ verdict: 'UNREADABLE', text: 'garbled output' })
      const commentOnPr = vi.fn(async () => { throw new Error('gh: rate limited') })
      const log = vi.fn()
      const d = deps({ secondOpinion, commentOnPr, log })

      const result = await runReviewLoop(input, d)

      expect(result.finalVerdict).toBe('UNREADABLE')
      expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to post the "review unavailable" comment'))
    })
  })

  // Real fixture, issue #870, live incident `fleet-infra-722` (2026-09-19):
  // round one's review service itself errored ("Unexpected server error" —
  // an infra failure, not a real reviewer reading the diff and objecting),
  // so `secondOpinion` correctly returned UNREADABLE — but by the time the
  // loop tried to send that verdict back for a revision, the worker's own
  // tmux session (dispatch-one.sh) had ALREADY exited, having already
  // finished with its own real terminal SUCCESS and a real PR (#861). The
  // exact `tmux send-keys` error text this loop saw in production:
  const FLEET_INFRA_722_TMUX_ERROR =
    'Command failed: tmux send-keys -t fleet-infra-722 The non-author reviewer requested changes on this PR:\n\n' +
    '{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.",' +
    '"ref":"err_20e4d34c"}}\n\nPlease revise. Enter\ncan\'t find pane: fleet-infra-722\n'

  describe('issue #870: reviseWithWorker unreachable (fleet-infra-722)', () => {
    it('ends the loop gracefully with the current verdict instead of throwing the tmux failure', async () => {
      const secondOpinion = vi.fn<ReviewLoopDeps['secondOpinion']>()
        .mockResolvedValue({ verdict: 'UNREADABLE', text: 'Unexpected server error. Check server logs for details.' })
      const reviseWithWorker = vi.fn(async () => { throw new Error(FLEET_INFRA_722_TMUX_ERROR) })
      const log = vi.fn()
      const d = deps({ secondOpinion, reviseWithWorker, log })

      // Before the fix, this exception propagated straight out of
      // runReviewLoop, through runLiveDispatch's try block, into tick.ts's
      // generic catch-all — which recorded a hard FAILED over a worker that
      // had, per its own status file, already finished correctly.
      const result = await runReviewLoop(input, d)
      expect(result.finalVerdict).toBe('UNREADABLE')
      expect(result.needsHuman).toBe(true)
      // Ended on round 1 — the worker was already gone, so there is no
      // round 2 to have run at all.
      expect(result.rounds).toBe(1)
      expect(reviseWithWorker).toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith(expect.stringContaining('could not reach the worker to revise'))
    })

    it('never re-runs verifyMechanical or secondOpinion for a round that could not be reached', async () => {
      const secondOpinion = vi.fn<ReviewLoopDeps['secondOpinion']>()
        .mockResolvedValue({ verdict: 'UNREADABLE', text: 'Unexpected server error.' })
      const reviseWithWorker = vi.fn(async () => { throw new Error(FLEET_INFRA_722_TMUX_ERROR) })
      const verifyMechanical = vi.fn(async () => passingReport())
      const d = deps({ secondOpinion, reviseWithWorker, verifyMechanical })

      await runReviewLoop(input, d)

      expect(verifyMechanical).toHaveBeenCalledTimes(1)
      expect(secondOpinion).toHaveBeenCalledTimes(1)
    })
  })
})
