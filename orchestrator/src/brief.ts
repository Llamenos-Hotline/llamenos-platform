import {
  SECRET_PATH_PATTERNS, TRUST_ANCHOR_APPROVERS, TRUST_ANCHOR_FILES, type Lane, type TrustAnchorFile,
} from './config.js'
import type { ReviewOutcomeToken } from './ci.js'
import { ROUTINE_XCODEGEN_PATHS } from './xcodegen-trust.js'
import { SECRET_TEMPLATE_SUFFIXES } from './fragments.js'
import type { WorkItem } from './source.js'

export interface BriefSection {
  heading: string
  body: string
}

/**
 * Composable, not one opaque string. A later augmentation step adds context
 * a fresh dispatch does not have — the last reviewer verdict, a governing
 * interface contract from a sibling lane's in-flight work — and needs to
 * ADD a section, not string-splice into the middle of one. If buildBrief
 * returned a single string here, that augmentation would end up doing
 * fragile text surgery on prose it does not own.
 */
export interface Brief {
  sections: BriefSection[]
}

export function renderBrief(brief: Brief): string {
  return brief.sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n')
}

/** What a content-judged trust anchor's rule holds, as a worker is told it. */
const CONTENT_RULE_SUMMARY: Record<NonNullable<TrustAnchorFile['contentRule']>, string> = {
  'xcodegen-spec': `held only when it changes something outside ${ROUTINE_XCODEGEN_PATHS.map((r) => `\`${r.path}\``).join(', ')}`,
}

/** The token a held trust-anchor PR shows (#2559) — named so a worker reads it as the hold it was told about. */
const SIGN_OFF_PENDING: ReviewOutcomeToken = 'NO-VERDICT:sign-off-pending'

/**
 * The write gate's two refusals, as the worker is told them (#2556) —
 * rendered from the SAME constants `verifyMechanical` enforces
 * (`SECRET_PATH_PATTERNS`, `TRUST_ANCHOR_FILES`, `TRUST_ANCHOR_APPROVERS`),
 * so the brief and the gate cannot describe different classes. A worker
 * that learns about a trust anchor only from a red `fleet/verify` has
 * already spent its session on a PR it was never told needs a human.
 */
export function writeGateRules(): string {
  const patterns = SECRET_PATH_PATTERNS.map((p) => `\`${p}\``).join(', ')
  const templates = SECRET_TEMPLATE_SUFFIXES.map((t) => `\`${t}\``).join('/')
  const anchors = TRUST_ANCHOR_FILES.map((a) =>
    `  - \`${a.path}\` — ${a.anchors}${a.contentRule === undefined ? '' : ` (${CONTENT_RULE_SUMMARY[a.contentRule]})`}`,
  ).join('\n')
  return (
    `- Never write secret material. A file whose path matches a secret pattern (${patterns}) is refused — ` +
    `except a committed ${templates} template and a \`*.pem\` that is provably public certificate material — and ` +
    `so is a private key in ANY file, whatever its name, tests and fixtures included. No approval clears this: ` +
    `generate a test key at test time instead of committing one.\n` +
    `- A change to a shipped client's trust anchors lands only after a human (${TRUST_ANCHOR_APPROVERS.join(', ')}) ` +
    `signs off on the exact head commit. These files, and any diff that adds or removes a pin literal or TLS trust ` +
    `hook in shipped client source:\n${anchors}\n` +
    `  If your issue genuinely needs such a change, make it, say so in the PR description, and say so in your ` +
    `status \`notes:\` — the gate will hold the PR until that sign-off, and \`fleet/review\` reports ` +
    `\`${SIGN_OFF_PENDING}\` meanwhile: that is the expected hold, not a defect to fix or re-run. Never change one incidentally, and never ` +
    `post a sign-off yourself: it is the human's statement that they checked the values, and nobody else's.`
  )
}

/**
 * Assembles a worker's entire task specification. Every section here exists
 * because of a specific failure mode in the reference system (Atlas): a
 * worker that merged its own PR, one that "helpfully" ran the full suite and
 * burned its whole budget on unrelated flakes, one that silently widened its
 * scope instead of saying so, and one that wrote a status file with no
 * parseable terminal outcome so the orchestrator had to guess.
 *
 * Fix round 2, M2: this used to also take `priorAttempts` and append its own
 * "Previous attempts" section — duplicating `memory.ts`'s `augmentBrief`,
 * which does the identical filter-by-item / sort / cap-at-three / render
 * under a different heading ("Prior attempts on this item"). A caller that
 * used both (as `cli.ts` did, and as `tick.ts` was always going to) would
 * render the same failure history twice under two headings — precisely the
 * "wastes the worker's context for no information" failure this brief
 * exists to avoid, reached by a path no test caught. `memory.ts` is now the
 * SOLE owner of prior-attempt history: this function no longer takes or
 * renders it at all, which makes double-rendering structurally impossible
 * rather than a wiring convention someone has to remember. Any caller that
 * wants prior-attempt context must go through `augmentBrief`.
 */
export function buildBrief(item: WorkItem, lane: Lane, branch: string): Brief {
  const sections: BriefSection[] = [
    {
      heading: `Issue #${item.id}: ${item.title}`,
      body: `${item.url}\n\n${item.body}`,
    },
    {
      heading: 'Branch',
      body: `Work on branch \`${branch}\`. Do not create or push to any other branch.`,
    },
    {
      heading: 'Scope',
      body:
        `You own these paths and ONLY these paths:\n\n` +
        lane.scope.owned.map((p) => `- \`${p}\``).join('\n') +
        `\n\nA fix that crosses into files another LANE owns (a route plus the schema it declares and ` +
        `the client that sends it; a catalog permission plus the migration that grants it) is still ONE ` +
        `problem and ONE PR — take those files. At PR open the orchestrator reads your diff, applies the ` +
        `\`scope:<lane>\` label(s) it needs, says so in a PR comment, and re-requests review, so do not ` +
        `split the change and do not label the PR yourself. It will NOT do this for CI/deploy/supply-chain ` +
        `paths (\`.github/workflows/\`, \`deploy/\`, \`Dockerfile*\`, \`Caddyfile*\`, \`knope.toml\`, ` +
        `\`package.json\`, \`bun.lockb\`) owned by another lane, for secrets, or for a path no lane owns ` +
        `— a diff holding one gets no grant at all and stops at \`NO-VERDICT:scope\`.\n\n` +
        `If the fix genuinely requires touching one of THOSE (a grant-excluded or unowned path), ` +
        `do NOT touch it. You then have TWO options, and choosing between them is your ` +
        `judgement call:\n\n` +
        `1. If a smaller fix that fits inside your scope is genuinely an improvement, make ` +
        `that one, and note in your final status exactly what you left out and why.\n` +
        `2. If the only fix that fits would be WORSE than doing nothing — deleting a feature ` +
        `rather than adding a dependency, storing state in memory rather than in the schema, ` +
        `duplicating a shared type rather than changing it, weakening a guarantee to make a ` +
        `test pass — then report BLOCKED instead, naming the path you needed and why the ` +
        `in-scope alternative is worse.\n\n` +
        `Option 2 is a correct and valued outcome, not a failure. A scope boundary must never ` +
        `decide a product or architectural question by default: that is a human's call, and ` +
        `reporting BLOCKED is how you hand it to them. Shipping the lesser fix with an honest ` +
        `note does NOT hand it over — the note arrives in a pull request that is already open, ` +
        `green, and heading for auto-merge.\n\n` +
        `Never silently widen your scope.`,
    },
    {
      heading: 'What you must NOT do',
      body:
        `- Never merge your own pull request, and never add it to the merge queue. Open exactly one PR ` +
        `and stop — only the supervisor queues a fleet PR. This is enforced, not advisory (#1894): a ` +
        `guard in the merge queue rejects any fleet PR that enters it without the supervisor's own ` +
        `signal, so a worker-enqueued entry fails the PR's required checks, is ejected, and the ejection ` +
        `record reads as your PR's fault. Self-check before writing your status file: run ` +
        `\`gh pr view <N> --json mergeStateStatus,autoMergeRequest\`. If you ever ran \`gh pr merge\` in ` +
        `any form, or that output shows the PR in a merge queue, you have violated the dispatch contract ` +
        `— say so explicitly in your status \`notes:\` so the supervisor can dequeue it.\n` +
        `- Your PR description MUST contain the line \`Closes #${item.id}\` on its own line. ` +
        `That is what closes issue #${item.id} when the PR merges; without it the issue stays ` +
        `open after the work has landed.\n` +
        `${writeGateRules()}\n` +
        `- Never deploy anything, to any environment.\n` +
        `- Never send anything (no notifications, no messages, no emails) as a side effect of this work.\n` +
        `- Do not run the full test suite. Run only the tests your diff actually touches — ` +
        `a full run on an unattended worker burns budget on failures that have nothing to do with your change.`,
    },
    {
      heading: 'Output contract',
      body:
        `When you are finished, write your status file's final line as exactly one of:\n\n` +
        `- \`DONE <pr-url>\` — you opened exactly one PR and it is ready for review.\n` +
        `- \`BLOCKED <reason>\` — you could not finish; say specifically why, so the next ` +
        `attempt (or a human) knows what to try differently.`,
    },
  ]

  return { sections }
}
