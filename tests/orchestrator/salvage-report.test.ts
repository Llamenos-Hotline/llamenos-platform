import { describe, expect, it } from 'vitest'
import { renderSalvageSection, salvageLine, summarizeSalvage } from '../../orchestrator/src/salvage-report.js'
import { renderDigest, resumeCommand, type DigestInput } from '../../orchestrator/src/digest.js'
import type { SalvageInventoryEntry } from '../../orchestrator/src/worktree.js'

// Issue #2699: 61 salvage branches accrued unseen. These pin that the backlog
// renders from one function on every surface, and that "could not look" never
// reads as "nothing there".

const e = (over: Partial<SalvageInventoryEntry> & { branch: string }): SalvageInventoryEntry => ({
  sha: 'a'.repeat(40), hasWorktree: false, realFiles: 3, artifactFiles: 0, obsolete: false, pushed: true, ...over,
})

describe('summarizeSalvage', () => {
  it('splits work, artifact-only, unreadable and obsolete, and finds the single-disk ones', () => {
    const s = summarizeSalvage([
      e({ branch: 'salvage/fleet/backend/1-1', pushed: false }),
      e({ branch: 'salvage/fleet/backend/2-1', pushed: true }),
      e({ branch: 'salvage/fleet/backend/3-1', realFiles: 0 }),
      e({ branch: 'salvage/fleet/backend/4-1', realFiles: undefined }),
      e({ branch: 'salvage/fleet/backend/5-1', realFiles: 0, obsolete: true, hasWorktree: true }),
    ])
    expect(s.total).toBe(5)
    expect(s.withWork.map((x) => x.branch)).toEqual(['salvage/fleet/backend/1-1', 'salvage/fleet/backend/2-1'])
    expect(s.unpushed.map((x) => x.branch)).toEqual(['salvage/fleet/backend/1-1'])
    expect(s.artifactOnly).toBe(1)
    expect(s.unreadable.length).toBe(1)
    expect(s.obsoleteKept).toBe(1)
  })

  it('does not count an unknown push state as unpushed', () => {
    const s = summarizeSalvage([e({ branch: 'salvage/fleet/backend/1-1', pushed: undefined })])
    expect(s.unpushed).toEqual([])
    expect(s.pushStateKnown).toBe(false)
  })
})

describe('salvageLine', () => {
  it('prints nothing for a fleet with no backlog', () => {
    expect(salvageLine([], 0)).toBe('')
  })

  it('names the count, the work, the single-disk ones and what was retired', () => {
    const line = salvageLine([e({ branch: 'salvage/fleet/backend/1-1', pushed: false }), e({ branch: 'salvage/fleet/backend/2-1' })], 4)
    expect(line).toContain('2 branch(es)')
    expect(line).toContain('2 holding work')
    expect(line).toContain('1 ONLY on this disk')
    expect(line).toContain('4 empty branch(es) retired this pass')
  })

  it('says so when origin could not be asked, instead of implying everything is backed up', () => {
    expect(salvageLine([e({ branch: 'salvage/fleet/backend/1-1', pushed: undefined })], 0)).toContain('push state unknown')
  })
})

describe('renderSalvageSection', () => {
  it('lists each branch holding work with its issue and where it lives', () => {
    const out = renderSalvageSection([
      e({ branch: 'salvage/fleet/desktop/1008-1', itemId: '1008', realFiles: 32, pushed: false }),
      e({ branch: 'salvage/fleet/android/1278-1', itemId: '1278', realFiles: 2, pushed: true }),
    ], 0)
    expect(out).toContain('salvage/fleet/desktop/1008-1 (issue #1008): 32 file(s), LOCAL ONLY')
    expect(out).toContain('salvage/fleet/android/1278-1 (issue #1278): 2 file(s), on origin')
    expect(out).toContain('git push origin <branch>')
  })

  it('names an unreadable branch rather than dropping it', () => {
    expect(renderSalvageSection([e({ branch: 'salvage/fleet/backend/4-1', realFiles: undefined })], 0)).toContain('could not diff against origin/main')
  })

  it('caps the listing and points at doctor for the rest', () => {
    const many = Array.from({ length: 30 }, (_, i) => e({ branch: `salvage/fleet/backend/${i}-1` }))
    expect(renderSalvageSection(many, 0)).toContain('and 5 more')
  })
})

describe('the digest carries the salvage section', () => {
  const base: DigestInput = {
    halted: false, resumeCommand: resumeCommand('/x'), lanes: [], recentRuns: [], awaitingHuman: [], rejections: [],
    dependency: { ok: true, commit: 'abc', problems: [] } as unknown as DigestInput['dependency'],
  }

  it('renders the section when the caller read the inventory', () => {
    expect(renderDigest({ ...base, salvage: [e({ branch: 'salvage/fleet/backend/1-1', itemId: '1' })] })).toContain('## Salvage branches')
  })

  it('omits it when nobody read the inventory, so an unread backlog never shows as "(none)"', () => {
    expect(renderDigest(base)).not.toContain('Salvage branches')
  })
})
