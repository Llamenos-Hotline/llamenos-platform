// Offline tests for the pin-comment guard's parsing and verdict logic.
// The network half (git ls-remote / compare API) is exercised by running the
// guard itself in CI; here a fake ls-remote answer stands in for upstream.
import { describe, expect, test } from "bun:test";
import { evaluate, parsePins, parseLsRemote } from "./check-action-pins.ts";

const C_OLD = "65a9edc5881444af0b9093a5e628f2fe47ea3b2e"; // v4.1.7 commit
const C_NEW = "9000827ccba6bdab643e8b6fd33ac0654aef8333"; // v8.0.2 commit
const TAG_OBJ = "f085ef0a201e8d974d0356a2d9de5447d10af42d"; // annotated tag object

const LS = [
  `${C_OLD}\trefs/tags/v4.1.7`, // lightweight tag
  `${TAG_OBJ}\trefs/tags/v8.0.2`, // annotated: object ...
  `${C_NEW}\trefs/tags/v8.0.2^{}`, // ... peeled to the commit
  `${C_NEW}\trefs/tags/v8`,
  `${C_NEW}\trefs/heads/main`,
].join("\n");
const refs = parseLsRemote(LS);

const pin = (sha: string, ref: string | null) => ({ file: "f.yml", line: 1, repo: "actions/download-artifact", sha, ref });

describe("parsePins", () => {
  test("reads list-item and plain forms, subpath actions, quotes and extra spacing", () => {
    const text = [
      `      - uses: actions/checkout@${C_NEW} # v7.0.0`,
      `        uses: github/codeql-action/analyze@${C_NEW}  # v4.39.0 trailing words`,
      `        uses: "docker/login-action@${C_NEW}" # v4.6.0`,
      `      - uses: returntocorp/semgrep-action@${C_NEW}`,
      `        uses: ./local-action`,
      `        uses: actions/cache@v4`,
      `      # uses: actions/cache@${C_NEW} # v1.0.0  (commented out)`,
    ].join("\n");
    const pins = parsePins(text, "x.yml");
    expect(pins.map((p) => [p.repo, p.ref])).toEqual([
      ["actions/checkout", "v7.0.0"],
      ["github/codeql-action", "v4.39.0"],
      ["docker/login-action", "v4.6.0"],
      ["returntocorp/semgrep-action", null],
    ]);
  });
});

describe("evaluate", () => {
  test("accepts a version comment that matches the tag's commit", () => {
    expect(evaluate(pin(C_NEW, "v8.0.2"), refs).kind).toBe("ok");
  });
  test("accepts a pin on the annotated tag object", () => {
    expect(evaluate(pin(TAG_OBJ, "v8.0.2"), refs).kind).toBe("ok");
  });
  test("rejects the #2040 defect: a v8 SHA commented as v4.1.7", () => {
    const v = evaluate(pin(C_NEW, "v4.1.7"), refs);
    expect(v.kind).toBe("bad");
    if (v.kind === "bad") expect(v.message).toContain("v8.0.2");
  });
  test("rejects an exact-version comment naming a tag that does not exist", () => {
    expect(evaluate(pin(C_NEW, "v9.9.9"), refs).kind).toBe("bad");
  });
  test("rejects an exact-version comment on a SHA that is no release at all", () => {
    expect(evaluate(pin("a".repeat(40), "v8.0.2"), refs).kind).toBe("bad");
  });
  test("rejects a missing comment", () => {
    expect(evaluate(pin(C_NEW, null), refs).kind).toBe("bad");
  });
  test("moving ref at its tip is ok; behind its tip needs an ancestry check; unknown ref is bad", () => {
    expect(evaluate(pin(C_NEW, "v8"), refs).kind).toBe("ok");
    expect(evaluate(pin(C_OLD, "v8"), refs).kind).toBe("ancestor-check");
    expect(evaluate(pin(C_NEW, "v99"), refs).kind).toBe("bad");
  });
});
