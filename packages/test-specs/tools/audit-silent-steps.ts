#!/usr/bin/env bun
/**
 * Silent-pass step audit (#709).
 *
 * `validate-coverage.ts` proves a scenario's steps are *bound* to a step
 * definition (phrase-level matching) — its own doc comment is explicit that
 * this "DOES NOT catch ... whether the body of a matched step definition is
 * correct/complete ... a step registered with the right phrase but an empty
 * or wrong implementation still counts as covered." That gap is exactly how
 * a scenario can go green while asserting nothing: the step binds, the test
 * runs, and the body silently returns without checking anything.
 *
 * This script closes the gap the other tool explicitly disclaims. It parses
 * every step definition body (TypeScript Given/When/Then for desktop and
 * backend; Kotlin @Given/@When/@Then/@And/@But for Android) and flags two
 * kinds of silent pass:
 *
 *   1. An EMPTY or COMMENT-ONLY body, for any keyword. A step that runs no
 *      code at all cannot fail, regardless of what it claims to do.
 *   2. A `Then` step whose body contains no call to an assertion function
 *      — `expect(...)`/`assert...(...)` on the TS side, `assert...(...)`/
 *      `Assert.xxx(...)`/`onView(...).check(...)` on the Kotlin side. A
 *      `Then`'s entire contract is checking an outcome; one that performs
 *      actions instead (or merely re-navigates) passes no matter what
 *      state the app is actually in.
 *
 * `Given`/`When` (and Kotlin's `And`/`But`, whose registered keyword is not
 * a reliable role indicator — see below) are intentionally NOT required to
 * call an assertion function: they set up state or perform an action, and
 * Playwright/Espresso both throw on a missing element or failed action, so
 * a broken one already fails loudly without an explicit `expect()`. See the
 * comment on `hasAssertion` for the measurement that justifies this split.
 *
 * This is a heuristic, not a type checker: it proves a `Then` step calls
 * *some* function whose name looks like an assertion, not that the
 * assertion is meaningful (`expect(true).toBe(true)` would not be
 * flagged), and it cannot tell a deliberate, documented no-op (e.g.
 * `tests/steps/backend/common.steps.ts`'s `'the server is reset'`) from an
 * unintentional stub — both are empty. It is a floor, not a ceiling — see
 * packages/test-specs/STRATEGY.md.
 *
 * Usage:
 *   bun packages/test-specs/tools/audit-silent-steps.ts
 *   bun packages/test-specs/tools/audit-silent-steps.ts --platform desktop-backend
 *   bun packages/test-specs/tools/audit-silent-steps.ts --platform android
 *   bun packages/test-specs/tools/audit-silent-steps.ts --json
 *
 * Exit codes:
 *   0 — every platform's silent-step count is at or below its baseline.
 *   1 — a platform's count exceeds its baseline (a regression), or exceeds
 *       it because a step was added or had its assertion removed.
 */

import { readFileSync } from "fs";
import { join, relative, dirname } from "path";
import { fileURLToPath } from "url";
import { findFiles } from "./validate-coverage";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../..");
const DESKTOP_BACKEND_STEPS_DIR = join(ROOT, "tests/steps");
const ANDROID_STEPS_DIR = join(
  ROOT,
  "apps/android/app/src/androidTest/java/org/llamenos/hotline/steps"
);

export type AuditPlatform = "desktop-backend" | "android";

export interface SilentStepFinding {
  platform: AuditPlatform;
  file: string; // relative to repo root
  line: number; // 1-indexed line of the keyword call/annotation
  keyword: string;
  pattern: string;
  reason: "empty-or-comment-only-body" | "no-assertion-call";
}

// ---- Shared body-matching helpers ----

/**
 * Find the index of the first top-level `{` at or after `fromIndex`,
 * skipping over string/char/template literals and line/block comments so
 * braces that appear inside them are never mistaken for the function or
 * arrow-body opener. Returns -1 if none is found before the end of the
 * string.
 */
function findBodyOpenBrace(content: string, fromIndex: number): number {
  let i = fromIndex;
  while (i < content.length) {
    const c = content[i];
    if (c === "{") return i;
    if (c === "/" && content[i + 1] === "/") {
      const nl = content.indexOf("\n", i);
      i = nl === -1 ? content.length : nl + 1;
      continue;
    }
    if (c === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      i = skipStringLiteral(content, i, c);
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Find the index of the first top-level occurrence of a literal `needle`
 * (e.g. `"=>"`) at or after `fromIndex`, skipping string/template literals
 * and comments the same way `findBodyOpenBrace` does. Returns -1 if not
 * found before the end of the string. Used to locate an arrow function's
 * `=>` so the body-open-brace search can start AFTER it — starting the
 * brace search right after the call's arguments would instead find the
 * callback parameter list's own braces (e.g. the `{ page }` in
 * `({ page }) => { ... }`) and misidentify them as the function body.
 */
function findTopLevel(content: string, fromIndex: number, needle: string): number {
  let i = fromIndex;
  while (i < content.length) {
    const c = content[i];
    if (content.startsWith(needle, i)) return i;
    if (c === "/" && content[i + 1] === "/") {
      const nl = content.indexOf("\n", i);
      i = nl === -1 ? content.length : nl + 1;
      continue;
    }
    if (c === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      i = skipStringLiteral(content, i, c);
      continue;
    }
    i++;
  }
  return -1;
}

/** Skip a string/char/template literal starting at `openIndex` (content[openIndex] === quote). Returns the index just past the closing quote. */
function skipStringLiteral(content: string, openIndex: number, quote: string): number {
  let i = openIndex + 1;
  while (i < content.length) {
    if (content[i] === "\\") {
      i += 2;
      continue;
    }
    if (content[i] === quote) return i + 1;
    i++;
  }
  return content.length;
}

/**
 * Given the index of an opening `{`, return the substring between it and
 * its matching closing `}` (exclusive of both braces), skipping braces
 * inside string/char/template literals and comments. Returns null if the
 * brace is unterminated (should not happen in valid source).
 */
function extractBracedBody(content: string, openBraceIndex: number): string | null {
  let depth = 0;
  let i = openBraceIndex;
  const start = openBraceIndex + 1;
  while (i < content.length) {
    const c = content[i];
    if (c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      i++;
      if (depth === 0) return content.slice(start, i - 1);
      continue;
    }
    if (c === "/" && content[i + 1] === "/") {
      const nl = content.indexOf("\n", i);
      i = nl === -1 ? content.length : nl + 1;
      continue;
    }
    if (c === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      i = skipStringLiteral(content, i, c);
      continue;
    }
    i++;
  }
  return null;
}

/** Strip line and block comments from a body so a comment-only body reads as blank. */
function stripComments(body: string): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i);
      i = nl === -1 ? body.length : nl + 1;
      continue;
    }
    if (c === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i + 2);
      i = end === -1 ? body.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const end = skipStringLiteral(body, i, c);
      out += body.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

const TS_ASSERTION_RE = /\b(expect|assert)[A-Za-z0-9_]*\s*\(/;
const KOTLIN_ASSERTION_RE = /\b[A-Za-z0-9_.]*[Aa]ssert[A-Za-z0-9_]*\s*\(|\.check\s*\(/;

/**
 * `requireAssertionCall` is only true for steps registered under the
 * `Then` keyword. Rationale: a `Given`/`When` (and Kotlin's `And`/`But`,
 * whose registered keyword does not reliably indicate the role they play
 * at a given call site — see validate-coverage.ts's "Desktop/backend
 * matching semantics" note on `matchKeywords` not being enabled) step
 * performs setup or an action; Playwright/Espresso's own throw-on-missing-
 * element behavior means a broken one fails loudly without needing an
 * explicit `expect()`/`assert*()` call. Measured: requiring an assertion
 * call from every keyword flagged 1106/3121 desktop/backend steps (35%) —
 * almost entirely legitimate action steps like "I click the dark theme
 * button" — which is not a credible silent-pass rate for a suite this
 * battle-tested and swamps the signal. `Then` is different: its entire
 * contract is checking an outcome, so one with no assertion call *is* the
 * silent-pass bug this audit exists to catch (`no-assertion-call` below).
 *
 * The empty-or-comment-only-body check applies to every keyword
 * regardless — a step that does nothing at all is never legitimate
 * (mirrors the established rule in tests/steps/crypto/crypto-steps.ts,
 * added for #1222), though some occurrences are deliberate, documented
 * no-ops (e.g. `tests/steps/backend/common.steps.ts`'s `'the server is
 * reset'`) rather than defects — see packages/test-specs/STRATEGY.md for how
 * those are triaged out of the baseline.
 */
function hasAssertion(
  body: string,
  re: RegExp,
  requireAssertionCall: boolean
): "empty-or-comment-only-body" | "no-assertion-call" | null {
  const stripped = stripComments(body).trim();
  if (stripped === "") return "empty-or-comment-only-body";
  if (requireAssertionCall && !re.test(stripped)) return "no-assertion-call";
  return null;
}

// ---- Desktop/backend (TypeScript, playwright-bdd) ----

/**
 * Matches `Given(`/`When(`/`Then(` followed by a single/double-quoted
 * Cucumber Expression pattern. Mirrors `parsePlaywrightBddStepDefs` in
 * validate-coverage.ts (same call shape), but this scanner also needs the
 * match's end index to go find the function body, so it re-implements the
 * extraction rather than importing that function's return shape.
 */
const TS_CALL_RE = /\b(Given|When|Then)\s*\(\s*(['"])((?:\\.|(?!\2)[\s\S])*)\2/g;

export function findSilentTsSteps(path: string, content: string): SilentStepFinding[] {
  const findings: SilentStepFinding[] = [];
  const relPath = relative(ROOT, path);
  let match: RegExpExecArray | null;
  TS_CALL_RE.lastIndex = 0;
  while ((match = TS_CALL_RE.exec(content)) !== null) {
    const keyword = match[1];
    const pattern = match[3];
    const callEnd = match.index + match[0].length;
    const arrowIndex = findTopLevel(content, callEnd, "=>");
    if (arrowIndex === -1) continue; // not an arrow-function callback; nothing to inspect
    const openBrace = findBodyOpenBrace(content, arrowIndex + 2);
    if (openBrace === -1) continue; // not a block-bodied callback; nothing to inspect
    const body = extractBracedBody(content, openBrace);
    if (body === null) continue;
    const reason = hasAssertion(body, TS_ASSERTION_RE, keyword === "Then");
    if (reason !== null) {
      findings.push({
        platform: "desktop-backend",
        file: relPath,
        line: lineNumberAt(content, match.index),
        keyword,
        pattern,
        reason,
      });
    }
  }
  return findings;
}

export function auditDesktopBackendSteps(): SilentStepFinding[] {
  const files = findFiles(DESKTOP_BACKEND_STEPS_DIR, ".ts");
  const findings: SilentStepFinding[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    findings.push(...findSilentTsSteps(file, content));
  }
  return findings;
}

// ---- Android (Kotlin, Cucumber) ----

/** Matches `@Given("...")`, `@When("...")`, `@Then("...")`, `@And("...")`, `@But("...")`. */
const KOTLIN_ANNOTATION_RE = /@(Given|When|Then|And|But)\("((?:\\.|[^"\\])*)"\)/g;
const KOTLIN_FUN_RE = /\bfun\s+\w+\s*\([^)]*\)/;

export function findSilentKotlinSteps(path: string, content: string): SilentStepFinding[] {
  const findings: SilentStepFinding[] = [];
  const relPath = relative(ROOT, path);
  let match: RegExpExecArray | null;
  KOTLIN_ANNOTATION_RE.lastIndex = 0;
  while ((match = KOTLIN_ANNOTATION_RE.exec(content)) !== null) {
    const keyword = match[1];
    const pattern = match[2];
    const afterAnnotation = match.index + match[0].length;
    const funMatch = KOTLIN_FUN_RE.exec(content.slice(afterAnnotation));
    if (!funMatch || funMatch.index === undefined) continue;
    const funEnd = afterAnnotation + funMatch.index + funMatch[0].length;
    const openBrace = findBodyOpenBrace(content, funEnd);
    if (openBrace === -1) continue;
    const body = extractBracedBody(content, openBrace);
    if (body === null) continue;
    const reason = hasAssertion(body, KOTLIN_ASSERTION_RE, keyword === "Then");
    if (reason !== null) {
      findings.push({
        platform: "android",
        file: relPath,
        line: lineNumberAt(content, match.index),
        keyword,
        pattern,
        reason,
      });
    }
  }
  return findings;
}

export function auditAndroidSteps(): SilentStepFinding[] {
  const files = findFiles(ANDROID_STEPS_DIR, ".kt");
  const findings: SilentStepFinding[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    findings.push(...findSilentKotlinSteps(file, content));
  }
  return findings;
}

// ---- Ratchet baseline ----

/**
 * Baseline counts, measured 2026-10-08 when this audit was introduced
 * (#709). This is a RATCHET, like `COVERAGE_THRESHOLDS` in
 * validate-coverage.ts: it exists so that adding a new silent-pass step (or
 * stripping the assertion out of an existing one) fails CI instead of
 * passing silently. It must only ever move DOWN, as real findings are
 * fixed — never up, and never raised just to make a red run green.
 *
 * Neither number is zero because this audit's job is to make the existing
 * debt visible and non-growing, not to silently absorb a backlog it did
 * not create:
 *
 * `android` is 87 (65 empty/comment-only, 22 Then-without-assertion). These
 * are handed to #765 (Android substitute/empty-step sweep), which already
 * owns fixing this exact category — this script hands it the count and the
 * list, it does not fix them itself.
 *
 * `desktop-backend` is 52 (32 empty/comment-only, 20 Then-without-
 * assertion). None fall inside `tests/steps/crypto/` (confirmed — that
 * directory has carried a stricter "no empty/comment-only body" rule since
 * #1222 and this audit found zero violations of it). All 52 are in
 * desktop/backend-owned step files this issue's lane has no write access
 * to; they are filed as #1747 for those lanes rather than fixed here — see
 * packages/test-specs/STRATEGY.md.
 */
const BASELINE: Record<AuditPlatform, number> = {
  "desktop-backend": 52,
  android: 87,
};

// ---- CLI ----

function parsePlatformArg(): AuditPlatform[] {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--platform");
  if (idx === -1 || !args[idx + 1]) return ["desktop-backend", "android"];
  const value = args[idx + 1];
  if (value === "desktop-backend" || value === "android") return [value];
  console.error(`Unknown platform: ${value}. Use: desktop-backend, android`);
  process.exit(1);
}

function main() {
  const asJson = process.argv.includes("--json");
  const platforms = parsePlatformArg();

  const allFindings: SilentStepFinding[] = [];
  if (platforms.includes("desktop-backend")) allFindings.push(...auditDesktopBackendSteps());
  if (platforms.includes("android")) allFindings.push(...auditAndroidSteps());

  if (asJson) {
    console.log(JSON.stringify(allFindings, null, 2));
  } else {
    console.log("Silent-pass step audit (#709)\n");
  }

  let failed = false;
  for (const platform of platforms) {
    const findings = allFindings.filter((f) => f.platform === platform);
    const baseline = BASELINE[platform];
    const overBaseline = findings.length > baseline;
    if (overBaseline) failed = true;

    if (!asJson) {
      const status = overBaseline ? "FAIL" : "ok";
      console.log(`  [${status}] ${platform}: ${findings.length} silent step(s) (baseline: ${baseline})`);
      if (findings.length > 0) {
        for (const f of findings) {
          console.log(`      ${f.file}:${f.line}  @${f.keyword}("${f.pattern}")  — ${f.reason}`);
        }
      }
      if (overBaseline) {
        console.log(
          `      Baseline exceeded: ${findings.length} > ${baseline}. A step was added without an` +
            ` assertion, or an existing assertion was removed. Fix the step, or lower the baseline only`+
            ` if this is a deliberate, reviewed reduction in the ratchet (never to make a red run green).`
        );
      }
    }
  }

  if (!asJson) {
    console.log(
      failed
        ? "\nFAILED: one or more platforms exceeded their silent-step baseline."
        : "\nPASSED: all platforms are at or below their silent-step baseline."
    );
  }

  process.exit(failed ? 1 : 0);
}

export const __testing = {
  findBodyOpenBrace,
  extractBracedBody,
  stripComments,
  hasAssertion,
  TS_ASSERTION_RE,
  KOTLIN_ASSERTION_RE,
  BASELINE,
};

if (import.meta.main) {
  main();
}
