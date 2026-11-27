import {
  CERTIFICATE_ONLY_PATTERNS, matchesSecretPath, publicCertificateVerdict,
} from './fragments.js'
import { SECRET_PATH_PATTERNS, TRUST_ANCHOR_APPROVERS, TRUST_ANCHOR_FILES, type TrustAnchorFile } from './config.js'
import { findPrivateKeyMaterial, latin1 } from './key-material.js'

/**
 * The write gate's classification of a changed file (#2556). Three answers,
 * each with its own remedy, and each refusal says which one it is:
 *
 * 1. **secret** — never agent-writable, and no approval clears it. A path
 *    matching `SECRET_PATH_PATTERNS` (minus the committed-template and
 *    public-certificate carve-outs), or ANY file whose content holds private
 *    key material (`findPrivateKeyMaterial`), wherever it sits — `tests/`,
 *    `testdata/` and a `.ts` source file included. A path is a guess; the
 *    bytes are the fact, so both are checked.
 * 2. **trust anchor** — a file that IS the trust control (`TRUST_ANCHOR_FILES`:
 *    the sign-off ledger, the snapshot extractor and its tests). Writable, but
 *    it lands only once a human in `TRUST_ANCHOR_APPROVERS` has signed off on
 *    the exact commit under judgement (`trustAnchorApprovers`). Since #3069 a
 *    file that merely CARRIES a pin is not here: what a shipped client trusts
 *    is a value, tracked by the trust snapshot and gated where a client
 *    artifact is produced, not by which file a diff happens to touch.
 * 3. **writable** — everything else, including a public certificate chain
 *    used as test input, which is published data and carries no secret.
 *
 * Before #2556 the gate had only the first class, decided by path alone, and
 * it was inverted relative to risk: it refused two public Let's Encrypt
 * chains #2550 needed as test input, while the five files that decide what
 * our clients trust were freely writable and its message ("touched
 * never-write paths") could not say which of those situations it was in.
 *
 * Pure: every function here takes the bytes and the diff text it judges. The
 * reading is done once, in `verifyMechanical` (verify.ts), inside the trusted
 * base checkout with the head commit as data.
 */

/** How a content finding's reason begins — the refusal keys its remedy on it. */
const CONTENT_KEY_WHY = 'its content holds'

/** A file's bytes as read from the commit under judgement. A string is
 *  accepted too (treated as latin1) so pure callers and tests can pass text. */
export type FileContent = string | Uint8Array

function asText(c: FileContent): string {
  return typeof c === 'string' ? c : latin1(c)
}

function asBytes(c: FileContent): Uint8Array {
  return typeof c === 'string' ? Buffer.from(c, 'latin1') : c
}

/** The first secret pattern a file's PATH matches without a carve-out
 *  applying, and why — or `undefined`. */
function pathSecretFinding(file: string, patterns: readonly string[], text: string | undefined): string | undefined {
  const lookup = text === undefined ? undefined : () => text
  for (const p of patterns) {
    if (!matchesSecretPath(file, p, lookup)) continue
    if (CERTIFICATE_ONLY_PATTERNS.includes(p)) {
      if (text === undefined) {
        return `its path matches secret pattern "${p}" and there is no content to show it is a public certificate ` +
          '(deleted, or not read)'
      }
      const verdict = publicCertificateVerdict(text)
      // `matchesSecretPath` already said "not public"; the verdict says why.
      const why = verdict.public ? 'its content is not provably public' : verdict.reason
      return `its path matches secret pattern "${p}" and its content is not provably public certificate material: ${why}`
    }
    return `its path matches secret pattern "${p}"`
  }
  return undefined
}

/**
 * Why `file` is never agent-writable, or `undefined` when it is not a secret.
 *
 * `content` is the file as the head commit holds it, or `undefined` when there
 * is none to read (a deletion, or a caller with no content lookup). Without
 * content only the path half can speak — the pre-#2556 behaviour, where
 * every `*.pem` is a secret — so callers that CAN read the bytes must: the
 * content half is the one that sees a key under a harmless name.
 *
 * Checked in this order, so the reason names the decisive fact first: the
 * path, then the bytes. A template (`.env.example`) is exempt from the path
 * half only; a real key pasted into it is still found by the content half.
 */
export function secretFinding(
  file: string,
  patterns: readonly string[] = SECRET_PATH_PATTERNS,
  content?: FileContent,
): string | undefined {
  const byPath = pathSecretFinding(file, patterns, content === undefined ? undefined : asText(content))
  if (byPath !== undefined) return byPath
  if (content === undefined) return undefined
  const key = findPrivateKeyMaterial(asBytes(content))
  return key === undefined ? undefined : `${CONTENT_KEY_WHY} ${key.kind} (line ${key.line})`
}

// ---------------------------------------------------------------------------
// Trust anchors.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Trust anchors: the files that implement the control (#3069).
// ---------------------------------------------------------------------------

export function trustAnchorEntry(file: string): TrustAnchorFile | undefined {
  return TRUST_ANCHOR_FILES.find((e) => e.path === file)
}

/**
 * Why changing `file` is a trust-anchor change, or `undefined`: the file is one
 * of the few that implement the trust control (`TRUST_ANCHOR_FILES`), and any
 * change to one — deleting or renaming it included — is held, whatever the
 * diff does. A file that only CARRIES a trust value is not judged here at all.
 */
export function trustAnchorFinding(file: string): string | undefined {
  const entry = trustAnchorEntry(file)
  return entry === undefined ? undefined : `it is ${entry.anchors}`
}

/** One review on a pull request, as `GET /repos/{r}/pulls/{n}/reviews`
 *  reports it, in the order GitHub returns them (oldest first). */
export interface PrReview {
  login: string | undefined
  state: string
  commitId: string | undefined
}

/** One conversation comment on a pull request (`GET /repos/{r}/issues/{n}/comments`). */
export interface PrComment {
  login: string | undefined
  body: string
  /** Set when a GitHub App posted it — never a human's sign-off. */
  viaApp?: boolean
  /** Set when the comment was edited after it was posted (`updated_at` is
   *  later than `created_at`). An edited sign-off is refused: editing a
   *  stale sign-off to name a new head is exactly the shortcut that would
   *  turn "a human checked THIS commit" into "someone changed a number". */
  edited?: boolean
  /** Where it is, so the gate's log can name every sign-off it accepted. */
  url?: string
}

/**
 * The line a human writes to sign off on a trust-anchor change: exactly
 * `trust-anchor sign-off: <full 40-hex head SHA>`, alone on its line.
 *
 * Why a comment and not only an approval: in this repo `rhonda-rodododo`
 * opens every PR, fleet workers included, and GitHub forbids an author's
 * approval of their own PR — so an approval-only rule would make every
 * trust-anchor PR, #2550 first, permanently unlandable. The sign-off line
 * is a deliberate human statement that works whoever opened the PR.
 *
 * Why the FULL SHA: it binds the sign-off to one commit. A push moves the
 * head, the line no longer names it, and the change is held again. A short
 * SHA or the word "head" is refused.
 *
 * Anchored to a whole line, so prose that merely MENTIONS the format — the
 * gate's own refusal text, a brief, this comment — can never read as one.
 */
export const TRUST_ANCHOR_SIGN_OFF = /^[ \t]*trust-anchor sign-off:[ \t]*([0-9a-f]{40})[ \t]*$/gm

/** The commits `body` signs off on. */
export function signedOffShas(body: string): string[] {
  return [...body.matchAll(TRUST_ANCHOR_SIGN_OFF)].map((m) => m[1] as string)
}

/**
 * The trust-anchor approvers who have signed off on `approvedSha`, by either
 * of two human acts:
 *
 * 1. a sign-off line (`TRUST_ANCHOR_SIGN_OFF`) naming `approvedSha`, in a PR
 *    conversation comment written by an approver — the PR's author included,
 *    since that is who the operator is here. Never a comment a GitHub App
 *    posted, and never one that was EDITED after posting. Review bodies are
 *    not read: the REST API reports no edit time for them, so an edit there
 *    could not be refused.
 * 2. an APPROVED review of exactly `approvedSha` by an approver who is not
 *    the author (GitHub would not record the author's). A login counts only
 *    when its LATEST decisive review (APPROVED, CHANGES_REQUESTED or
 *    DISMISSED — a later plain COMMENT does not withdraw an approval, exactly
 *    as GitHub reads it) is that approval.
 *
 * Either way the sign-off names one commit, and a push after it is a change
 * nobody signed off on.
 */
/** The comments that ARE valid sign-offs on `approvedSha` — the same rule
 *  `trustAnchorApprovers` applies, exposed so the caller can log each one it
 *  accepted (a sign-off nobody can see is a defence nobody can audit). */
export function signOffComments(comments: readonly PrComment[], approvedSha: string): PrComment[] {
  return comments.filter((c) =>
    c.login !== undefined && TRUST_ANCHOR_APPROVERS.includes(c.login) && c.viaApp !== true && c.edited !== true &&
    signedOffShas(c.body).includes(approvedSha))
}

export function trustAnchorApprovers(input: {
  reviews: readonly PrReview[]
  comments?: readonly PrComment[]
  author: string | undefined
  approvedSha: string
}): string[] {
  const approvers = new Set<string>()
  const isApprover = (l: string | undefined): l is string => l !== undefined && TRUST_ANCHOR_APPROVERS.includes(l)

  for (const c of signOffComments(input.comments ?? [], input.approvedSha)) approvers.add(c.login as string)

  const latest = new Map<string, PrReview>()
  for (const r of input.reviews) {
    if (r.login === undefined || r.login.length === 0) continue
    if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED' && r.state !== 'DISMISSED') continue
    latest.set(r.login, r)
  }
  for (const r of latest.values()) {
    if (r.state === 'APPROVED' && r.commitId === input.approvedSha && r.login !== input.author && isApprover(r.login)) {
      approvers.add(r.login)
    }
  }
  return [...approvers].sort()
}

// ---------------------------------------------------------------------------
// The refusal text. One prefix per class, stable, and matched by trace.ts.
// ---------------------------------------------------------------------------

export const SECRET_REASON_PREFIX = 'touched never-write paths'
export const TRUST_ANCHOR_REASON_PREFIX = 'touched trust-anchor files'

export interface WriteFinding {
  file: string
  /** Starts with "its …" / "it is …": reads after the file name. */
  why: string
}

const listFindings = (findings: readonly WriteFinding[]): string =>
  findings.map((f) => `${f.file} (${f.why})`).join('; ')

/** The refusal for the secret class. Names the class, then every file with
 *  the fact that decided it, so "a real key" and "a `*.pem` the parser could
 *  not vouch for" never read the same. */
export function secretRefusal(findings: readonly WriteFinding[]): string {
  const keyInContent = findings.some((f) => f.why.startsWith(CONTENT_KEY_WHY))
  return `${SECRET_REASON_PREFIX} — secret material, never agent-writable and not clearable by any approval: ` +
    `${listFindings(findings)}` +
    (keyInContent ? '. A test key must be generated at test time, never committed' : '')
}

/**
 * The refusal for the trust-anchor class: what each file anchors, whose
 * approval clears it, on which commit, and what to do next. `approvers` is
 * `undefined` when the PR's reviews could not be read at all — said so,
 * because "could not ask" is not "nobody approved".
 */
export function trustAnchorRefusal(
  findings: readonly WriteFinding[],
  commit: string,
  approvers: readonly string[] | undefined,
): string {
  const who = TRUST_ANCHOR_APPROVERS.join(', ')
  const state = approvers === undefined
    ? `This PR's reviews and comments could not be read, so no sign-off on ${commit} could be confirmed (fails closed)`
    : `No trust-anchor approver (${who}) has signed off on ${commit}`
  // The sign-off format is DESCRIBED, never written as a line on its own:
  // this text is published in check output and review reports, and must not
  // itself parse as a sign-off (`TRUST_ANCHOR_SIGN_OFF` is line-anchored).
  return `${TRUST_ANCHOR_REASON_PREFIX} — the control over a shipped client's TLS trust decision, which lands only with a human ` +
    `sign-off: ${listFindings(findings)}. ${state}. A wrong value here disconnects every installed client and ` +
    'only a client release can undo it, so no automated review clears it: a human checks the change, then posts ' +
    'a NEW, unedited PR comment with a line reading "trust-anchor sign-off:" followed by this full head SHA (or, ' +
    'when they did not open the PR, approves this exact head), and re-requests review from llamenos-auto'
}
