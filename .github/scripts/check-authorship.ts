#!/usr/bin/env bun
/**
 * Assert WHO authored a pull request and every commit on it (#2916).
 *
 * Authorship is an input to the merge gates — `fleet-review.yml` branches on it
 * (`REVIEW_SKIP_AUTHORS`, `bot-authored`, the PR `llamenos-auto` authored
 * itself) and a code-owner approval is vacuous when the author is the sole
 * owner — while being an OUTPUT of ambient state: the credential that opened the
 * PR, and `user.email` in whichever checkout committed. Nothing asserted either,
 * so a PR under an unexpected identity silently took a different path through
 * the gates than its reviewers thought. This is the assertion.
 *
 * Two fields, each judged against its own allowlist, because they move
 * independently (right commits + wrong credential, and the reverse):
 *
 *   PR author         pull.user.login                 who opened it
 *   commit author     commit.author.email             every commit, not the head
 *   commit committer  commit.committer.email          every commit, not the head
 *
 * ALLOWLIST, never a reject-list: an identity nobody thought to list is refused,
 * not admitted. The set is scoped by branch namespace (RULES below): a
 * `fleet/<lane>/<n>` branch is machine-authored by construction, so its commits
 * may carry only the fleet identity; `release` is the fleet identity throughout;
 * `dependabot/*` is Dependabot throughout.
 *
 * FAILS CLOSED, and says which way it failed:
 *   exit 0  every field is in the allowed set
 *   exit 1  NOT ALLOWED — an identity is established and is not in the set
 *   exit 2  COULD NOT ESTABLISH — the author (or a commit's author/committer, or
 *           the commit list itself) could not be read, or the list is not
 *           provably complete. Never green, and never reported as exit 1: there
 *           is no identity to blame, only a lookup to repair.
 *
 * NOTHING READ OFF THE EVENT IS ECHOED. A PR author or commit email is
 * caller-controlled text on a public repository; a gate that reflected it into a
 * log, annotation or step summary would be an injection surface. Output carries
 * only constants this repository publishes (the rule name, the allowed set,
 * field names) and, for locating the offender, a commit's position in the series
 * and its SHA — a SHA is only printed after it matches /^[0-9a-f]{40}$/. The
 * branch is named by the RULE it matched, never by its raw ref, for the same
 * reason (a ref is also caller-chosen text).
 *
 * Limits, stated so nobody mistakes this for more than it is: a git email is a
 * claim, not a proof (anyone can set `user.email` to the fleet's noreply
 * address); this catches the ambient-config mistake, not a deliberate forgery.
 * The stronger control — a commit-metadata ruleset that rejects the push itself —
 * is deliberately a separate, later change. And under `pull_request` the PR's own
 * copy of this file runs; changes to it are CODEOWNER-reviewed like every other
 * path under .github/.
 *
 * Usage (CI): bun .github/scripts/check-authorship.ts
 *   env: GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GH_TOKEN,
 *        optional GITHUB_API_URL, GITHUB_STEP_SUMMARY
 */
import { appendFileSync, readFileSync } from "node:fs";

// ─── The known authoring identities ──────────────────────────────────────────
// The fleet identity is the one knope-release-pr.yml already configures for its
// own commits (`git config user.email`); a test pins the two to each other.

interface Identity {
  /** GitHub login, as `pull.user.login` reports it. */
  login: string;
  /** The git author/committer email its commits carry. Lower case. */
  email: string;
}

export const OPERATOR: Identity = {
  login: "rhonda-rodododo",
  email: "260308880+rhonda-rodododo@users.noreply.github.com",
};
export const FLEET: Identity = {
  login: "llamenos-auto",
  email: "333950803+llamenos-auto@users.noreply.github.com",
};
export const DEPENDABOT: Identity = {
  login: "dependabot[bot]",
  email: "49699333+dependabot[bot]@users.noreply.github.com",
};
/**
 * GitHub's own committer identity, stamped on a commit made through its web
 * flow (an "Update branch" merge, a UI edit, Dependabot's rebases). It is the
 * COMMITTER only — the AUTHOR of such a commit is still the person, and is still
 * checked — so allowing it as a committer admits no person.
 */
export const GITHUB_WEB_FLOW_EMAIL = "noreply@github.com";

export type RuleName = "release" | "dependabot" | "fleet" | "default";

export interface Rule {
  name: RuleName;
  /** What the rule is keyed on, in words the repository already publishes. */
  namespace: string;
  prAuthors: readonly string[];
  commitAuthors: readonly string[];
  committers: readonly string[];
}

const RULES: Record<RuleName, Rule> = {
  release: {
    name: "release",
    namespace: "the `release` branch (knope's release PR)",
    prAuthors: [FLEET.login],
    commitAuthors: [FLEET.email],
    committers: [FLEET.email, GITHUB_WEB_FLOW_EMAIL],
  },
  dependabot: {
    name: "dependabot",
    namespace: "a `dependabot/*` branch",
    prAuthors: [DEPENDABOT.login],
    commitAuthors: [DEPENDABOT.email],
    committers: [DEPENDABOT.email, GITHUB_WEB_FLOW_EMAIL],
  },
  // Machine-authored by construction: the PR may be opened by the operator's
  // credential or the fleet's, but its COMMITS carry the fleet identity only.
  fleet: {
    name: "fleet",
    namespace: "a `fleet/*` branch (a dispatched worker's)",
    prAuthors: [OPERATOR.login, FLEET.login],
    commitAuthors: [FLEET.email],
    committers: [FLEET.email, GITHUB_WEB_FLOW_EMAIL],
  },
  default: {
    name: "default",
    namespace: "any other branch",
    prAuthors: [OPERATOR.login, FLEET.login],
    commitAuthors: [OPERATOR.email, FLEET.email],
    committers: [OPERATOR.email, FLEET.email, GITHUB_WEB_FLOW_EMAIL],
  },
};

/**
 * Which rule governs a head ref. A reserved namespace is matched by PREFIX, so
 * a malformed `fleet/oops` is held to the narrow fleet rule rather than falling
 * through to the wider default one.
 */
export function ruleFor(headRef: string): Rule {
  if (headRef === "release") return RULES.release;
  if (headRef.startsWith("dependabot/")) return RULES.dependabot;
  if (headRef.startsWith("fleet/")) return RULES.fleet;
  return RULES.default;
}

// ─── Verdicts ────────────────────────────────────────────────────────────────

export interface CommitFacts {
  sha: unknown;
  authorEmail: unknown;
  committerEmail: unknown;
}

export interface PrFacts {
  headRef: unknown;
  authorLogin: unknown;
  /** `pull.commits` — how many commits GitHub says the PR has. */
  commitCount: unknown;
  commits: readonly CommitFacts[];
}

export type Finding =
  | { field: "pr-author" }
  | { field: "commit-author" | "commit-committer"; position: number; of: number; sha: string | null };

export type UnknownReason =
  | "no-branch"
  | "no-pr-author"
  | "no-commit-count"
  | "no-commits"
  | "commit-list-incomplete"
  | "commit-sha-unreadable"
  | "commit-author-unreadable"
  | "commit-committer-unreadable";

export type Verdict =
  | { kind: "allowed"; rule: Rule; commits: number }
  | { kind: "not-allowed"; rule: Rule; findings: Finding[] }
  | { kind: "unknown"; reason: UnknownReason };

const SHA = /^[0-9a-f]{40}$/;

function readable(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim().toLowerCase() : null;
}

/**
 * Pure verdict over facts already read. "Could not establish" wins over "not
 * allowed": a disallowed identity in a list we cannot prove complete is still an
 * unfinished lookup, and reporting only the part we happened to see would let the
 * unseen part go unexamined.
 */
export function evaluate(pr: PrFacts): Verdict {
  const branch = typeof pr.headRef === "string" && pr.headRef !== "" ? pr.headRef : null;
  if (branch === null) return { kind: "unknown", reason: "no-branch" };
  const rule = ruleFor(branch);

  const author = readable(pr.authorLogin);
  if (author === null) return { kind: "unknown", reason: "no-pr-author" };

  if (typeof pr.commitCount !== "number" || !Number.isInteger(pr.commitCount) || pr.commitCount < 0) {
    return { kind: "unknown", reason: "no-commit-count" };
  }
  if (pr.commits.length === 0) return { kind: "unknown", reason: "no-commits" };
  // The list endpoint silently stops at 250. A list shorter than what the PR says
  // it has is a partial view, and a partial view cannot be a pass.
  if (pr.commits.length !== pr.commitCount) return { kind: "unknown", reason: "commit-list-incomplete" };

  const facts = pr.commits.map((c) => ({
    sha: typeof c.sha === "string" && SHA.test(c.sha) ? c.sha : null,
    author: readable(c.authorEmail),
    committer: readable(c.committerEmail),
  }));
  for (const f of facts) {
    if (f.sha === null) return { kind: "unknown", reason: "commit-sha-unreadable" };
    if (f.author === null) return { kind: "unknown", reason: "commit-author-unreadable" };
    if (f.committer === null) return { kind: "unknown", reason: "commit-committer-unreadable" };
  }

  const findings: Finding[] = [];
  if (!rule.prAuthors.includes(author)) findings.push({ field: "pr-author" });
  facts.forEach((f, i) => {
    const at = { position: i + 1, of: facts.length, sha: f.sha };
    if (!rule.commitAuthors.includes(f.author!)) findings.push({ field: "commit-author", ...at });
    if (!rule.committers.includes(f.committer!)) findings.push({ field: "commit-committer", ...at });
  });
  return findings.length === 0
    ? { kind: "allowed", rule, commits: facts.length }
    : { kind: "not-allowed", rule, findings };
}

// ─── Rendering (constants and repository-published values only) ──────────────

const UNKNOWN_TEXT: Record<UnknownReason, string> = {
  "no-branch": "the PR's branch could not be read",
  "no-pr-author": "the PR's author could not be read",
  "no-commit-count": "the PR's commit count could not be read",
  "no-commits": "the PR reports no commits to check",
  "commit-list-incomplete":
    "the commit list is not provably complete (the API returned a different number of commits than the PR has — it stops at 250)",
  "commit-sha-unreadable": "a commit's SHA could not be read",
  "commit-author-unreadable": "a commit's author could not be read",
  "commit-committer-unreadable": "a commit's committer could not be read",
};

export function allowedSetText(rule: Rule): string {
  return [
    `rule: ${rule.name} — ${rule.namespace}`,
    `  PR author:        ${rule.prAuthors.join(", ")}`,
    `  commit author:    ${rule.commitAuthors.join(", ")}`,
    `  commit committer: ${rule.committers.join(", ")}`,
  ].join("\n");
}

export function describeFinding(f: Finding): string {
  if (f.field === "pr-author") return "the PR author is not in the allowed set";
  const which = f.field === "commit-author" ? "author" : "committer";
  const where = f.sha ? ` (${f.sha})` : "";
  return `commit ${f.position} of ${f.of}${where}: its ${which} email is not in the allowed set`;
}

export function render(v: Verdict): { exit: 0 | 1 | 2; lines: string[]; title: string } {
  if (v.kind === "allowed") {
    return {
      exit: 0,
      title: "authorship: allowed",
      lines: [`authorship: the PR author and all ${v.commits} commit(s) are in the allowed set`, allowedSetText(v.rule)],
    };
  }
  if (v.kind === "unknown") {
    return {
      exit: 2,
      title: "authorship: COULD NOT ESTABLISH (not a verdict on the identity)",
      lines: [
        `authorship: COULD NOT ESTABLISH — ${UNKNOWN_TEXT[v.reason]}.`,
        "This is a failure, not a pass: an author that cannot be established is never green. It is NOT a finding that the author is wrong — fix the lookup, or push again.",
      ],
    };
  }
  return {
    exit: 1,
    title: "authorship: NOT ALLOWED",
    lines: [
      `authorship: NOT ALLOWED — ${v.findings.length} field(s) outside the allowed set for this branch.`,
      ...v.findings.map((f) => `  - ${describeFinding(f)}`),
      "Allowed set for this branch:",
      allowedSetText(v.rule),
      "Fix: set `user.email` in the checkout that committed to the identity above (git config user.email …), rewrite the commit(s), and open the PR with the matching credential. The observed value is deliberately not printed.",
    ],
  };
}

// ─── Reading the facts from the GitHub API ───────────────────────────────────

class LookupError extends Error {}

interface ApiPull {
  number?: unknown;
  user?: { login?: unknown } | null;
  head?: { ref?: unknown; sha?: unknown } | null;
  commits?: unknown;
}
interface ApiCommit {
  sha?: unknown;
  commit?: { author?: { email?: unknown } | null; committer?: { email?: unknown } | null } | null;
}

async function api<T>(url: string, token: string): Promise<T> {
  let last = "no attempt made";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (res.ok) return (await res.json()) as T;
      last = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break; // not transient: do not retry
    } catch (e) {
      last = `network error (${(e as Error).name})`;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  throw new LookupError(`GitHub API request failed: ${last}`);
}

/** The head SHA and number the triggering event named, read defensively. */
export function readEvent(raw: string): { number: number; headSha: string } {
  let ev: { pull_request?: { number?: unknown; head?: { sha?: unknown } } };
  try {
    ev = JSON.parse(raw);
  } catch {
    throw new LookupError("the event payload is not JSON");
  }
  const number = ev.pull_request?.number;
  const headSha = ev.pull_request?.head?.sha;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
    throw new LookupError("the event payload names no pull request");
  }
  if (typeof headSha !== "string" || !SHA.test(headSha)) {
    throw new LookupError("the event payload names no head commit");
  }
  return { number, headSha };
}

async function readPr(repo: string, apiUrl: string, token: string, event: { number: number; headSha: string }): Promise<PrFacts> {
  const base = `${apiUrl}/repos/${repo}/pulls/${event.number}`;
  const pull = await api<ApiPull>(base, token);
  // The PR is read fresh, not from the event snapshot, so a re-run cannot judge a
  // stale body. If the head has moved since this run started, THIS run's head is
  // no longer what is being judged and a newer run owns it: no verdict here.
  if (pull.head?.sha !== event.headSha) {
    throw new LookupError("the PR head moved after this run started; the newer run judges it");
  }
  const commits: CommitFacts[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await api<ApiCommit[]>(`${base}/commits?per_page=100&page=${page}`, token);
    if (!Array.isArray(batch)) throw new LookupError("the commit list was not a list");
    for (const c of batch) {
      commits.push({ sha: c.sha, authorEmail: c.commit?.author?.email, committerEmail: c.commit?.committer?.email });
    }
    if (batch.length < 100) break;
  }
  return { headRef: pull.head?.ref, authorLogin: pull.user?.login, commitCount: pull.commits, commits };
}

function writeSummary(title: string, lines: string[]): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `### ${title}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
}

async function main(): Promise<never> {
  const finish = (v: Verdict): never => {
    const out = render(v);
    for (const l of out.lines) (out.exit === 0 ? console.log : console.error)(l);
    if (out.exit !== 0) console.error(`::error title=${out.title}::${out.lines[0]}`);
    writeSummary(out.title, out.lines);
    process.exit(out.exit);
  };
  const couldNot = (message: string): never => {
    console.error(`authorship: COULD NOT ESTABLISH — ${message}. This is a failure, not a pass.`);
    console.error(`::error title=authorship: COULD NOT ESTABLISH (not a verdict on the identity)::${message}`);
    writeSummary("authorship: COULD NOT ESTABLISH (not a verdict on the identity)", [message]);
    process.exit(2);
  };

  const { GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GH_TOKEN } = process.env;
  // Only a pull_request has an author to judge. Any other event reaching this
  // script is a wiring mistake, and it must not pass by having nothing to read.
  if (GITHUB_EVENT_NAME !== "pull_request") couldNot("this check only judges a pull_request event");
  if (!GITHUB_EVENT_PATH || !GITHUB_REPOSITORY || !GH_TOKEN) couldNot("the environment names no event, repository or token");
  try {
    const event = readEvent(readFileSync(GITHUB_EVENT_PATH!, "utf8"));
    const apiUrl = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
    return finish(evaluate(await readPr(GITHUB_REPOSITORY!, apiUrl, GH_TOKEN!, event)));
  } catch (e) {
    // Only our own LookupErrors carry text we composed. Anything else (a bug, a
    // parse failure on a hostile payload) is reported by kind alone.
    return couldNot(e instanceof LookupError ? e.message : "an unexpected error reading the PR");
  }
}

if (import.meta.main) await main();
