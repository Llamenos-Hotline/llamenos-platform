import type { SalvageInventoryEntry } from './worktree.js'

/**
 * Issue #2699: the standing consequence of every killed worker — "N branches
 * are waiting on a human, here they are" — as a value the tick line, `status`,
 * `doctor` and the digest all render from. Before this the only mention was a
 * per-issue refusal comment, so 61 branches accrued unseen, 48 of them on a
 * single disk. Pure: no I/O, so what each surface prints is one function of
 * one inventory.
 */
export interface SalvageSummary {
  total: number
  /** Real work beyond what main already has — the ones a human must reconcile. */
  withWork: SalvageInventoryEntry[]
  /** Hold nothing but gitignored artifacts. */
  artifactOnly: number
  /** Could not be diffed — "could not look", never counted as empty. */
  unreadable: SalvageInventoryEntry[]
  /** `withWork` entries with no copy on origin: one disk failure from lost. */
  unpushed: SalvageInventoryEntry[]
  /** Obsolete branches this pass could not retire (a worktree is attached). */
  obsoleteKept: number
  /** Whether origin could be asked about what it holds. */
  pushStateKnown: boolean
}

export function summarizeSalvage(entries: SalvageInventoryEntry[]): SalvageSummary {
  const live = entries.filter((e) => e.obsolete !== true)
  const withWork = live.filter((e) => e.realFiles !== undefined && e.realFiles > 0)
  return {
    total: entries.length,
    withWork,
    artifactOnly: live.filter((e) => e.realFiles === 0).length,
    unreadable: live.filter((e) => e.realFiles === undefined),
    unpushed: withWork.filter((e) => e.pushed === false),
    obsoleteKept: entries.length - live.length,
    pushStateKnown: entries.every((e) => e.pushed !== undefined),
  }
}

/** One line for the tick output and `status`. Empty string when there is no
 *  backlog, so a quiet fleet prints nothing extra. */
export function salvageLine(entries: SalvageInventoryEntry[], retired: number): string {
  if (entries.length === 0 && retired === 0) return ''
  const s = summarizeSalvage(entries)
  const parts = [`${s.withWork.length} holding work`]
  if (s.unpushed.length > 0) parts.push(`${s.unpushed.length} ONLY on this disk (not on origin)`)
  if (s.unreadable.length > 0) parts.push(`${s.unreadable.length} unreadable`)
  if (s.artifactOnly > 0) parts.push(`${s.artifactOnly} artifact-only`)
  if (!s.pushStateKnown) parts.push('origin unreachable — push state unknown')
  if (retired > 0) parts.push(`${retired} empty branch(es) retired this pass`)
  return `salvage: ${s.total} branch(es) — ${parts.join(', ')}`
}

const MAX_LISTED = 25

/** The digest section: the count, then each branch that needs a human. */
export function renderSalvageSection(entries: SalvageInventoryEntry[], retired: number): string {
  const s = summarizeSalvage(entries)
  const lines: string[] = []
  const line = salvageLine(entries, retired)
  if (line.length > 0) lines.push(`- ${line}`)
  if (s.unpushed.length > 0) {
    lines.push(
      `- ${s.unpushed.length} of them exist on the dispatch host's disk alone — ` +
      'back one up with `git push origin <branch>` (or rebase and PR it, or discard it deliberately)',
    )
  }
  for (const e of s.withWork.slice(0, MAX_LISTED)) {
    const issue = e.itemId !== undefined ? ` (issue #${e.itemId})` : ''
    const where = e.pushed === true ? 'on origin' : e.pushed === false ? 'LOCAL ONLY' : 'origin unknown'
    lines.push(`  - ${e.branch}${issue}: ${e.realFiles} file(s), ${where}${e.hasWorktree ? ', worktree attached' : ''}`)
  }
  if (s.withWork.length > MAX_LISTED) lines.push(`  - … and ${s.withWork.length - MAX_LISTED} more — run \`llamenos-fleet doctor\` for the full list`)
  for (const e of s.unreadable.slice(0, MAX_LISTED)) lines.push(`  - ${e.branch}: could not diff against origin/main — inspect by hand`)
  return ['## Salvage branches', ...(lines.length > 0 ? lines : ['  (none)'])].join('\n')
}
