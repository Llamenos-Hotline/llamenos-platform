// Offline tests for the authorship gate's verdict logic (#2916). The API half is
// exercised by running the gate itself in CI; here the facts are handed in.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEPENDABOT,
  FLEET,
  GITHUB_WEB_FLOW_EMAIL,
  OPERATOR,
  evaluate,
  readEvent,
  render,
  ruleFor,
  type CommitFacts,
  type PrFacts,
} from "./check-authorship.ts";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const commit = (n: number, author: string, committer = author): CommitFacts => ({
  sha: sha(n),
  authorEmail: author,
  committerEmail: committer,
});
const pr = (over: Partial<PrFacts> & { commits?: CommitFacts[] }): PrFacts => {
  const commits = over.commits ?? [commit(1, FLEET.email)];
  return { headRef: "fleet/infra/2916", authorLogin: OPERATOR.login, commitCount: commits.length, ...over, commits };
};

describe("ruleFor — branch namespace picks the allowed set", () => {
  test("reserved namespaces are matched by prefix, everything else is default", () => {
    expect(ruleFor("release").name).toBe("release");
    expect(ruleFor("dependabot/npm_and_yarn/x-1.2.3").name).toBe("dependabot");
    expect(ruleFor("fleet/infra/2916").name).toBe("fleet");
    // malformed but in the namespace: held to the NARROW rule, not the default
    expect(ruleFor("fleet/oops").name).toBe("fleet");
    expect(ruleFor("releases").name).toBe("default");
    expect(ruleFor("release/1.0").name).toBe("default");
    expect(ruleFor("fix/2916-thing").name).toBe("default");
    expect(ruleFor("xfleet/a/1").name).toBe("default");
  });
});

describe("evaluate — allowed", () => {
  test("a fleet branch: operator credential, fleet-authored commits, web-flow committer", () => {
    const v = evaluate(pr({ commits: [commit(1, FLEET.email), commit(2, FLEET.email, GITHUB_WEB_FLOW_EMAIL)] }));
    expect(v.kind).toBe("allowed");
  });
  test("a fleet branch opened by the fleet credential", () => {
    expect(evaluate(pr({ authorLogin: FLEET.login })).kind).toBe("allowed");
  });
  test("a plain branch accepts either known commit identity", () => {
    const v = evaluate(pr({ headRef: "fix/x", commits: [commit(1, OPERATOR.email), commit(2, FLEET.email)] }));
    expect(v.kind).toBe("allowed");
  });
  test("the release PR is the fleet identity throughout", () => {
    expect(evaluate(pr({ headRef: "release", authorLogin: FLEET.login })).kind).toBe("allowed");
  });
  test("a dependabot PR", () => {
    const v = evaluate(
      pr({ headRef: "dependabot/docker/x", authorLogin: DEPENDABOT.login, commits: [commit(1, DEPENDABOT.email, GITHUB_WEB_FLOW_EMAIL)] }),
    );
    expect(v.kind).toBe("allowed");
  });
  test("comparison ignores case and surrounding whitespace", () => {
    const v = evaluate(pr({ authorLogin: " Rhonda-Rodododo ", commits: [commit(1, ` ${FLEET.email.toUpperCase()} `)] }));
    expect(v.kind).toBe("allowed");
  });
});

describe("evaluate — not allowed", () => {
  test("a stray personal email on a commit", () => {
    const v = evaluate(pr({ commits: [commit(1, FLEET.email), commit(2, "someone@example.com"), commit(3, FLEET.email)] }));
    expect(v).toMatchObject({ kind: "not-allowed" });
    if (v.kind !== "not-allowed") throw new Error("unreachable");
    // commit() stamps the same email as author and committer, so both fields trip.
    expect(v.findings).toEqual([
      { field: "commit-author", position: 2, of: 3, sha: sha(2) },
      { field: "commit-committer", position: 2, of: 3, sha: sha(2) },
    ]);
  });
  test("EVERY commit is checked, not the head: only the first is wrong", () => {
    const v = evaluate(pr({ commits: [commit(1, "stray@example.com"), commit(2, FLEET.email), commit(3, FLEET.email)] }));
    expect(v.kind).toBe("not-allowed");
  });
  test("the committer is judged separately from the author", () => {
    const v = evaluate(pr({ commits: [commit(1, FLEET.email, "stray@example.com")] }));
    if (v.kind !== "not-allowed") throw new Error("expected not-allowed");
    expect(v.findings).toEqual([{ field: "commit-committer", position: 1, of: 1, sha: sha(1) }]);
  });
  test("right commits, wrong credential", () => {
    const v = evaluate(pr({ authorLogin: "someone-else" }));
    if (v.kind !== "not-allowed") throw new Error("expected not-allowed");
    expect(v.findings).toEqual([{ field: "pr-author" }]);
  });
  test("right credential, wrong commits", () => {
    expect(evaluate(pr({ commits: [commit(1, "stray@example.com")] })).kind).toBe("not-allowed");
  });
  test("a fleet branch is narrower than a plain one: operator-authored commits are refused", () => {
    expect(evaluate(pr({ commits: [commit(1, OPERATOR.email)] })).kind).toBe("not-allowed");
    expect(evaluate(pr({ headRef: "fix/x", commits: [commit(1, OPERATOR.email)] })).kind).toBe("allowed");
  });
  test("the web-flow identity is a committer only, never an author", () => {
    expect(evaluate(pr({ commits: [commit(1, GITHUB_WEB_FLOW_EMAIL)] })).kind).toBe("not-allowed");
  });
  test("dependabot is allowed only in its own namespace", () => {
    expect(evaluate(pr({ authorLogin: DEPENDABOT.login, commits: [commit(1, DEPENDABOT.email)] })).kind).toBe("not-allowed");
    expect(evaluate(pr({ headRef: "dependabot/x", authorLogin: OPERATOR.login, commits: [commit(1, OPERATOR.email)] })).kind).toBe(
      "not-allowed",
    );
  });
  test("the release PR refuses the operator identity", () => {
    expect(evaluate(pr({ headRef: "release", authorLogin: OPERATOR.login })).kind).toBe("not-allowed");
  });
  test("an unlisted identity is refused (allowlist, not reject-list)", () => {
    for (const email of ["x", "bot@users.noreply.github.com", "41898282+github-actions[bot]@users.noreply.github.com"]) {
      expect(evaluate(pr({ headRef: "fix/x", commits: [commit(1, email)] })).kind).toBe("not-allowed");
    }
  });
});

describe("evaluate — could not establish (never green, and not 'not allowed')", () => {
  const cases: Array<[string, PrFacts]> = [
    ["no branch", pr({ headRef: undefined })],
    ["empty branch", pr({ headRef: "" })],
    ["null author (deleted account)", pr({ authorLogin: null })],
    ["blank author", pr({ authorLogin: "  " })],
    ["no commit count", pr({ commitCount: undefined })],
    ["negative commit count", pr({ commitCount: -1 })],
    ["fractional commit count", pr({ commitCount: 1.5 })],
    ["no commits at all", pr({ commits: [], commitCount: 0 })],
    ["list shorter than the PR (API truncation)", pr({ commits: [commit(1, FLEET.email)], commitCount: 300 })],
    ["list longer than the PR", pr({ commits: [commit(1, FLEET.email), commit(2, FLEET.email)], commitCount: 1 })],
    ["unreadable sha", pr({ commits: [{ sha: "abc", authorEmail: FLEET.email, committerEmail: FLEET.email }] })],
    ["null author email", pr({ commits: [{ sha: sha(1), authorEmail: null, committerEmail: FLEET.email }] })],
    ["empty committer email", pr({ commits: [{ sha: sha(1), authorEmail: FLEET.email, committerEmail: "" }] })],
    ["non-string email", pr({ commits: [{ sha: sha(1), authorEmail: 7, committerEmail: FLEET.email }] })],
  ];
  for (const [name, facts] of cases) {
    test(name, () => {
      const v = evaluate(facts);
      expect(v.kind).toBe("unknown");
      expect(render(v).exit).toBe(2);
    });
  }
  test("an unknown wins over a not-allowed seen in the part we could read", () => {
    const v = evaluate(pr({ authorLogin: "someone-else", commits: [commit(1, FLEET.email)], commitCount: 251 }));
    expect(v.kind).toBe("unknown");
  });
});

describe("render — exit codes and injection safety", () => {
  test("allowed 0, not-allowed 1, unknown 2", () => {
    expect(render(evaluate(pr({}))).exit).toBe(0);
    expect(render(evaluate(pr({ authorLogin: "x" }))).exit).toBe(1);
    expect(render(evaluate(pr({ authorLogin: null }))).exit).toBe(2);
  });
  test("no observed value reaches the output", () => {
    const evilLogin = "evil-login\n::error::pwned";
    const evilEmail = "evil+inject%0A::warning::x@example.com";
    const evilRef = "fleet/evil\n::error::ref";
    const out = [
      render(evaluate(pr({ headRef: evilRef, authorLogin: evilLogin, commits: [commit(1, evilEmail, evilEmail)] }))),
      render(evaluate(pr({ headRef: evilRef, authorLogin: evilLogin, commits: [commit(1, evilEmail)], commitCount: 9 }))),
    ];
    for (const o of out) {
      const text = [o.title, ...o.lines].join("\n");
      expect(text).not.toContain("evil");
      expect(text).not.toContain("pwned");
      expect(text).not.toContain("::warning");
    }
  });
  test("a not-allowed verdict states the rule and the allowed set", () => {
    const text = render(evaluate(pr({ authorLogin: "x" }))).lines.join("\n");
    expect(text).toContain("fleet");
    expect(text).toContain(OPERATOR.login);
    expect(text).toContain(FLEET.email);
  });
  test("a not-allowed verdict locates the commit by position and sha", () => {
    const text = render(evaluate(pr({ commits: [commit(1, FLEET.email), commit(2, "s@e.x")] }))).lines.join("\n");
    expect(text).toContain(`commit 2 of 2 (${sha(2)})`);
  });
});

describe("readEvent", () => {
  test("reads number and head sha", () => {
    expect(readEvent(JSON.stringify({ pull_request: { number: 5, head: { sha: sha(9) } } }))).toEqual({ number: 5, headSha: sha(9) });
  });
  test("refuses anything else", () => {
    for (const raw of ["not json", "{}", JSON.stringify({ pull_request: { number: 5 } }), JSON.stringify({ pull_request: { number: "5", head: { sha: sha(9) } } })]) {
      expect(() => readEvent(raw)).toThrow();
    }
  });
});

describe("the allowlist stays tied to what the tree already says", () => {
  test("the fleet identity is the one knope-release-pr.yml configures for its own commits", () => {
    const wf = readFileSync(new URL("../workflows/knope-release-pr.yml", import.meta.url), "utf8");
    expect(wf).toContain(`git config user.email "${FLEET.email}"`);
    expect(wf).toContain(`git config user.name "${FLEET.login}"`);
  });
});
