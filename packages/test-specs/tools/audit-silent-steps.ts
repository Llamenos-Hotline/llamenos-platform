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

import { readFileSync, writeFileSync } from "fs";
import { join, relative, dirname } from "path";
import { fileURLToPath } from "url";
import {
  classifyAndroid,
  type AndroidPaths,
  extractScenarioSteps,
  findFiles,
  parseFeatureFile,
  stepMatchesCucumberPhrase,
  type Scenario,
} from "./validate-coverage";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../..");
const DESKTOP_BACKEND_STEPS_DIR = join(ROOT, "tests/steps");
const FEATURES_DIR = join(ROOT, "packages/test-specs/features");
const ANDROID_STEPS_DIR = join(
  ROOT,
  "apps/android/app/src/androidTest/java/org/llamenos/hotline/steps"
);

export type AuditPlatform = "desktop-backend" | "android";

export type SilentReason = "empty-or-comment-only-body" | "no-assertion-call" | "vacuous-assertion";

export interface SilentStepFinding {
  platform: AuditPlatform;
  file: string; // relative to repo root
  line: number; // 1-indexed line of the keyword call/annotation
  keyword: string;
  pattern: string;
  reason: SilentReason;
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

/**
 * Waits that THROW when their condition is never met. A `Then` that ends in one
 * of these cannot pass unless the outcome happened, so it is an assertion even
 * though its name does not say so (#2678: nine steps hardened to await the
 * server's reflected state were counted as "no assertion" because the audit only
 * knew `expect`/`assert`).
 *
 * Every Kotlin name here is a helper WE define, and `kotlinThrowingWaitDefinitions`
 * in the tests re-reads each definition and fails if it stops throwing - so adding
 * a name is a claim the suite checks, not an exemption. `waitForURL` is
 * Playwright's own and rejects on timeout. A bare `waitUntil` is deliberately NOT
 * accepted: only `composeRule.waitUntil` is (it throws ComposeTimeoutException);
 * an unqualified one could be anything.
 */
export const KOTLIN_THROWING_WAIT_HELPERS = [
  "awaitServerState", // helpers/SimulationClient.kt
  "awaitSwitchState", // steps/BaseSteps.kt
  "waitForNode", // steps/BaseSteps.kt
] as const;
const TS_ASSERTION_RE = /\b(expect|assert)[A-Za-z0-9_]*\s*\(|\.waitForURL\s*\(/;
const KOTLIN_ASSERTION_RE = new RegExp(
  "\\b[A-Za-z0-9_.]*[Aa]ssert[A-Za-z0-9_]*\\s*\\(|\\.check\\s*\\(|" +
    `\\b(?:${KOTLIN_THROWING_WAIT_HELPERS.join("|")})\\s*\\(|\\bcomposeRule\\.waitUntil\\s*\\(`
);

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
  requireAssertionCall: boolean,
  vacuous: RegExp[] = []
): SilentReason | null {
  const stripped = stripComments(body).trim();
  if (stripped === "") return "empty-or-comment-only-body";
  if (!requireAssertionCall) return null;
  if (!re.test(stripped)) return "no-assertion-call";
  // An assertion that cannot fail is not one (#2678). Remove the vacuous calls and ask again:
  // a step that ALSO makes a real assertion is fine, one whose only assertions are vacuous is not.
  const withoutVacuous = vacuous.reduce((acc, v) => acc.replace(v, ""), stripped);
  if (withoutVacuous !== stripped && !re.test(withoutVacuous)) return "vacuous-assertion";
  return null;
}

/**
 * Assertions that are true by construction, so the step passes whatever the app does.
 *
 * - TS: `expect(true).toBeTruthy()` / `.toBe(true)` and their `false` mirrors.
 * - Kotlin: `assertTrue(true)` / `assertFalse(false)`, and `assertAnyTagDisplayed(...)`
 *   given a screen ANCHOR alongside the tag the step is supposed to prove. An any-of
 *   assertion is only as strong as its weakest alternative: `("recent-notes-card",
 *   "dashboard-title")` passes on any dashboard, which is the screen the step is
 *   already on. That is exactly the shape of the `create-identity` assertions in the
 *   deleted `KeyImportSteps` (#2678) - they asserted the login screen was showing,
 *   which it always is. A LONE anchor is not flagged: "I am on the dashboard" is a
 *   legitimate thing to assert.
 *
 * Which tags are anchors is a judgement about the app, so the list is explicit.
 * The audit cannot know that an arbitrary tag is always present; that is a limit
 * of a static check, recorded in STRATEGY.md.
 */
export const KOTLIN_SCREEN_ANCHOR_TAGS = ["dashboard-title", "create-identity"] as const;
const TS_VACUOUS_ASSERTIONS: RegExp[] = [
  /\bexpect\s*\(\s*true\s*\)\s*\.\s*(?:toBeTruthy\s*\(\s*\)|toBe\s*\(\s*true\s*\))/g,
  /\bexpect\s*\(\s*false\s*\)\s*\.\s*(?:toBeFalsy\s*\(\s*\)|toBe\s*\(\s*false\s*\))/g,
];
const KOTLIN_ANCHORED_ANY_OF_RE = new RegExp(
  `\\bassertAnyTagDisplayed\\s*\\(\\s*(?=[^)]*"[^"]+"\\s*,\\s*"[^"]+")(?=[^)]*"(?:${KOTLIN_SCREEN_ANCHOR_TAGS.join("|")})")[^)]*\\)`,
  "g"
);
const KOTLIN_VACUOUS_ASSERTIONS: RegExp[] = [
  /\bassertTrue\s*\(\s*true\s*\)/g,
  /\bassertFalse\s*\(\s*false\s*\)/g,
  KOTLIN_ANCHORED_ANY_OF_RE,
];

// ---- Swallowed failures ----

/**
 * A step whose failure is caught and discarded. This is the sibling of the two
 * silent-pass reasons above and the one they cannot see: `hasAssertion` only
 * asks whether the body *calls* something assertion-shaped, never whether a
 * failure of that call can escape. In
 *
 *   try { onNodeWithTag("device-key-error").assertDoesNotExist() }
 *   catch (_: Throwable) { /* Error state unclear *\/ }
 *
 * the body contains an `assert…(` call, so the `Then` passes the audit, and the
 * step passes on every run regardless of what the screen shows (#2675).
 *
 * It matters for `Given`/`When` as well. `I start typing in the device key
 * field` caught the failure of its own `performTextInput` ("device key input
 * not available"), so on an app that has no such field the action was skipped
 * and the assertion after it was evaluated against a screen nobody touched.
 */
export type SwallowKind = "catch-without-rethrow" | "runCatching-without-getOrThrow" | "promise-catch-swallow";

export interface SwallowingStepFinding {
  platform: AuditPlatform;
  file: string;
  line: number;
  keyword: string;
  pattern: string;
  how: SwallowKind;
}

/** A catch block that re-raises: `throw`, or a call that throws (`fail`, `error`). */
const RETHROWS_RE = /\b(throw|fail|error)\b/;

/**
 * Returns how the body discards a failure, or null if it does not.
 *
 *  - `try { … } catch (…) { … }` whose catch block never throws or fails.
 *    Every catch type counts: a narrow `catch (_: AssertionError)` swallows an
 *    assertion exactly as `Throwable` does, and a narrow type that is *not* the
 *    thing being asserted is a step that still passes when the assertion fails
 *    in a different way.
 *  - Kotlin `runCatching { … }` with no `getOrThrow()` in the body.
 *  - TypeScript `.catch(() => …)` / `.catch(async () => …)` whose handler
 *    returns a value instead of throwing (the Playwright idiom for "ignore a
 *    timeout").
 */
function findSwallow(body: string, lang: "kotlin" | "ts"): SwallowKind | null {
  const stripped = stripComments(body);

  const catchRe = lang === "kotlin" ? /\bcatch\s*\([^)]*\)\s*\{/g : /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = catchRe.exec(stripped)) !== null) {
    const handler = extractBracedBody(stripped, m.index + m[0].length - 1);
    if (handler !== null && !RETHROWS_RE.test(handler)) return "catch-without-rethrow";
  }

  if (lang === "kotlin") {
    if (/\brunCatching\s*\{/.test(stripped) && !/\bgetOrThrow\s*\(/.test(stripped)) {
      return "runCatching-without-getOrThrow";
    }
  } else {
    const promiseCatchRe = /\.catch\s*\(\s*(?:async\s*)?\([^)]*\)\s*=>\s*/g;
    while ((m = promiseCatchRe.exec(stripped)) !== null) {
      const rest = stripped.slice(m.index + m[0].length);
      if (rest.startsWith("{")) {
        const handler = extractBracedBody(stripped, m.index + m[0].length);
        if (handler !== null && !RETHROWS_RE.test(handler)) return "promise-catch-swallow";
      } else if (!/^\s*(?:\(\s*)?throw\b/.test(rest)) {
        return "promise-catch-swallow";
      }
    }
  }
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

interface StepBody {
  keyword: string;
  pattern: string;
  /** Index of the keyword call / annotation in the file content. */
  index: number;
  body: string;
}

/** Every `Given/When/Then('…', async (…) => { body })` call whose callback has a block body. */
function* tsStepBodies(content: string): Generator<StepBody> {
  let match: RegExpExecArray | null;
  TS_CALL_RE.lastIndex = 0;
  while ((match = TS_CALL_RE.exec(content)) !== null) {
    const callEnd = match.index + match[0].length;
    const arrowIndex = findTopLevel(content, callEnd, "=>");
    if (arrowIndex === -1) continue; // not an arrow-function callback; nothing to inspect
    const openBrace = findBodyOpenBrace(content, arrowIndex + 2);
    if (openBrace === -1) continue; // not a block-bodied callback; nothing to inspect
    const body = extractBracedBody(content, openBrace);
    if (body === null) continue;
    yield { keyword: match[1], pattern: match[3], index: match.index, body };
  }
}

export function findSilentTsSteps(path: string, content: string): SilentStepFinding[] {
  const findings: SilentStepFinding[] = [];
  const relPath = relative(ROOT, path);
  for (const step of tsStepBodies(content)) {
    const reason = hasAssertion(step.body, TS_ASSERTION_RE, step.keyword === "Then", TS_VACUOUS_ASSERTIONS);
    if (reason !== null) {
      findings.push({
        platform: "desktop-backend",
        file: relPath,
        line: lineNumberAt(content, step.index),
        keyword: step.keyword,
        pattern: step.pattern,
        reason,
      });
    }
  }
  return findings;
}

export function findSwallowingTsSteps(path: string, content: string): SwallowingStepFinding[] {
  const relPath = relative(ROOT, path);
  const findings: SwallowingStepFinding[] = [];
  for (const step of tsStepBodies(content)) {
    const how = findSwallow(step.body, "ts");
    if (how !== null) {
      findings.push({
        platform: "desktop-backend",
        file: relPath,
        line: lineNumberAt(content, step.index),
        keyword: step.keyword,
        pattern: step.pattern,
        how,
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

/** Every `@Given/@When/@Then/@And/@But("…") fun …() { body }` with a block body. */
function* kotlinStepBodies(content: string): Generator<StepBody> {
  let match: RegExpExecArray | null;
  KOTLIN_ANNOTATION_RE.lastIndex = 0;
  while ((match = KOTLIN_ANNOTATION_RE.exec(content)) !== null) {
    const afterAnnotation = match.index + match[0].length;
    const funMatch = KOTLIN_FUN_RE.exec(content.slice(afterAnnotation));
    if (!funMatch || funMatch.index === undefined) continue;
    const funEnd = afterAnnotation + funMatch.index + funMatch[0].length;
    const openBrace = findBodyOpenBrace(content, funEnd);
    if (openBrace === -1) continue;
    const body = extractBracedBody(content, openBrace);
    if (body === null) continue;
    yield { keyword: match[1], pattern: match[2], index: match.index, body };
  }
}

export function findSilentKotlinSteps(path: string, content: string): SilentStepFinding[] {
  const findings: SilentStepFinding[] = [];
  const relPath = relative(ROOT, path);
  for (const step of kotlinStepBodies(content)) {
    const reason = hasAssertion(step.body, KOTLIN_ASSERTION_RE, step.keyword === "Then", KOTLIN_VACUOUS_ASSERTIONS);
    if (reason !== null) {
      findings.push({
        platform: "android",
        file: relPath,
        line: lineNumberAt(content, step.index),
        keyword: step.keyword,
        pattern: step.pattern,
        reason,
      });
    }
  }
  return findings;
}

export function findSwallowingKotlinSteps(path: string, content: string): SwallowingStepFinding[] {
  const relPath = relative(ROOT, path);
  const findings: SwallowingStepFinding[] = [];
  for (const step of kotlinStepBodies(content)) {
    const how = findSwallow(step.body, "kotlin");
    if (how !== null) {
      findings.push({
        platform: "android",
        file: relPath,
        line: lineNumberAt(content, step.index),
        keyword: step.keyword,
        pattern: step.pattern,
        how,
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

export function auditSwallowingSteps(platforms: AuditPlatform[]): SwallowingStepFinding[] {
  const findings: SwallowingStepFinding[] = [];
  if (platforms.includes("desktop-backend")) {
    for (const file of findFiles(DESKTOP_BACKEND_STEPS_DIR, ".ts")) {
      findings.push(...findSwallowingTsSteps(file, readFileSync(file, "utf-8")));
    }
  }
  if (platforms.includes("android")) {
    for (const file of findFiles(ANDROID_STEPS_DIR, ".kt")) {
      findings.push(...findSwallowingKotlinSteps(file, readFileSync(file, "utf-8")));
    }
  }
  return findings;
}

export interface ScenarioThroughSwallow {
  scenario: Scenario;
  /** The scenario step text that binds to a swallowing step definition. */
  step: string;
  swallow: SwallowingStepFinding;
}

/**
 * The blast radius of the Android swallowing steps, measured on what runs on a
 * device: scenarios the runner selects, ships and binds (`executed` in
 * `classifyAndroid`), not every scenario carrying an `@android` tag. A scenario
 * is listed when at least one of its steps binds to a swallowing step
 * definition of the given keyword set.
 *
 * `onlyThen` narrows this to the case that can never fail an assertion: a
 * `Then` whose own failure is discarded. A swallowing `Given`/`When` is
 * frequently benign (dismiss an optional dialog) and only weakens the scenario;
 * a swallowing `Then` makes its scenario's verdict independent of the app.
 */
export function androidScenariosThroughSwallow(
  scenarios: Scenario[],
  swallowing: SwallowingStepFinding[],
  onlyThen: boolean,
  paths?: AndroidPaths
): ScenarioThroughSwallow[] {
  const featuresDir = paths?.featuresDir ?? FEATURES_DIR;
  const android = swallowing.filter((f) => f.platform === "android" && (!onlyThen || f.keyword === "Then"));
  const { verdicts } = classifyAndroid(scenarios, paths);
  const hits: ScenarioThroughSwallow[] = [];
  for (const v of verdicts) {
    if (!v.executed) continue;
    for (const step of extractScenarioSteps(join(featuresDir, v.scenario.featureFile), v.scenario.title)) {
      const swallow = android.find((f) => stepMatchesCucumberPhrase(step, f.pattern));
      if (swallow) {
        hits.push({ scenario: v.scenario, step, swallow });
        break;
      }
    }
  }
  return hits;
}

export function loadAllScenarios(): Scenario[] {
  return findFiles(FEATURES_DIR, ".feature").flatMap((f) => parseFeatureFile(f));
}

// ---- Ratchet baseline ----

/**
 * Per-step ratchet for silent-pass steps (#709, reworked in #2678).
 *
 * This used to be one number per platform, and the number is what failed: it
 * could not tell a step that was FIXED from a step that was ADDED, so each fix
 * silently made room for a new offender, and with nothing running the audit the
 * counts drifted (desktop 52 -> 53, android 87 -> 93) until the guard exited 1 on
 * unmodified main. A count also gave a reviewer nothing to read: raising it looked
 * the same as lowering it.
 *
 * `silent-steps.baseline.json` now names every known offender (file, keyword,
 * pattern, reason - not line, which moves) with how many such definitions exist.
 * A finding beyond that is "new" and fails the run BY NAME, so swapping one silent
 * step for another is caught. An entry the code no longer produces is "stale":
 * reported, not fatal, so two PRs that each fix a step do not fail each other in
 * the merge queue - run `--write-baseline` to lock the progress in.
 *
 * `exempt` is for steps that are deliberately empty and say why. Each carries a
 * reason, because an exemption without one is just a bigger baseline.
 */
const SILENT_BASELINE_PATH = join(__dirname, "silent-steps.baseline.json");

export interface SilentExemption {
  platform: AuditPlatform;
  file: string;
  keyword: string;
  pattern: string;
  reason: string;
}

export interface SilentBaseline {
  description: string;
  /** key (see silentStepKey) -> number of definitions known to be silent. */
  known: Record<string, number>;
  exempt: SilentExemption[];
}

export function silentStepKey(f: Pick<SilentStepFinding, "platform" | "file" | "keyword" | "pattern" | "reason">): string {
  return `${f.platform} :: ${f.file} :: @${f.keyword}("${f.pattern}") :: ${f.reason}`;
}

export interface SilentGateResult {
  /** Findings beyond the baseline and the exemptions - each one a step that is new or newly silent. */
  unexpected: SilentStepFinding[];
  /** Baseline entries no finding matches any more (or fewer do): progress not yet locked in. */
  stale: string[];
  /** Findings accepted because the baseline names an exemption for them. */
  exempted: SilentStepFinding[];
}

export function evaluateSilentGate(findings: SilentStepFinding[], baseline: SilentBaseline): SilentGateResult {
  const exemptKeys = new Set(
    baseline.exempt.map((e) =>
      silentStepKey({ ...e, reason: "empty-or-comment-only-body" })
    )
  );
  const remaining = new Map(Object.entries(baseline.known));
  const unexpected: SilentStepFinding[] = [];
  const exempted: SilentStepFinding[] = [];
  const seen = new Map<string, number>();
  for (const f of findings) {
    const key = silentStepKey(f);
    if (exemptKeys.has(key)) {
      exempted.push(f);
      continue;
    }
    seen.set(key, (seen.get(key) ?? 0) + 1);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else unexpected.push(f);
  }
  const stale = [...remaining.entries()].filter(([, n]) => n > 0).map(([k, n]) => (n > 1 ? `${k}  (x${n})` : k));
  return { unexpected, stale, exempted };
}

export function loadSilentBaseline(path = SILENT_BASELINE_PATH): SilentBaseline {
  return JSON.parse(readFileSync(path, "utf-8")) as SilentBaseline;
}

/** Rewrite `known` from the current findings, keeping `exempt` and the description. */
export function writeSilentBaseline(findings: SilentStepFinding[], path = SILENT_BASELINE_PATH): void {
  const previous = loadSilentBaseline(path);
  const gate = evaluateSilentGate(findings, { ...previous, known: {} });
  const known: Record<string, number> = {};
  for (const f of gate.unexpected) {
    const key = silentStepKey(f);
    known[key] = (known[key] ?? 0) + 1;
  }
  const sorted = Object.fromEntries(Object.entries(known).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify({ ...previous, known: sorted }, null, 2)}\n`);
}

/**
 * Ratchet for swallowed failures (#2675), measured 2026-11-10 when the rule was
 * introduced. Same contract as the silent-step baseline: it only ever moves DOWN.
 *
 * `steps` is the number of step definitions that catch and discard a failure.
 * `androidExecutedThroughThen` is the number of scenarios that actually run on a
 * device (selected, shipped and bound — see classifyAndroid) and contain a step
 * bound to a swallowing `Then`. That is the number that matters: for each of
 * those scenarios an assertion exists in the source and cannot fail. It started at
 * 4 and the right end state is 0; every run lists them. Re-measured at 5 on
 * 2026-11-11: #2665 (admin revokes an invite) added "Admin can see pending invites
 * and revoke them", which reuses the already-flagged InviteSteps Then. The step
 * count did not move (291); one more device scenario now routes through it.
 */
const SWALLOW_BASELINE: { steps: Record<AuditPlatform, number>; androidExecutedThroughThen: number } = {
  steps: { "desktop-backend": 66, android: 291 },
  androidExecutedThroughThen: 5,
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

function reportSwallowing(
  platforms: AuditPlatform[],
  swallowing: SwallowingStepFinding[],
  throughThen: ScenarioThroughSwallow[],
  asJson: boolean
): boolean {
  let failed = false;
  const lines: string[] = ["\nSwallowed-failure audit (#2675)\n"];
  for (const platform of platforms) {
    const findings = swallowing.filter((f) => f.platform === platform);
    const baseline = SWALLOW_BASELINE.steps[platform];
    const over = findings.length > baseline;
    if (over) failed = true;
    const thens = findings.filter((f) => f.keyword === "Then").length;
    lines.push(
      `  [${over ? "FAIL" : "ok"}] ${platform}: ${findings.length} step(s) catch and discard a failure, ` +
        `${thens} of them Then (baseline: ${baseline})`
    );
    if (over) {
      for (const f of findings) lines.push(`      ${f.file}:${f.line}  @${f.keyword}("${f.pattern}")  — ${f.how}`);
      lines.push(
        `      Baseline exceeded: ${findings.length} > ${baseline}. A step now catches an exception and carries on,` +
          ` so it passes whether or not the app does what it claims. Rethrow, or assert the absence of the failure.`
      );
    }
  }
  if (platforms.includes("android")) {
    const over = throughThen.length > SWALLOW_BASELINE.androidExecutedThroughThen;
    if (over) failed = true;
    lines.push(
      `  [${over ? "FAIL" : "ok"}] android: ${throughThen.length} scenario(s) that run on a device contain a Then` +
        ` whose failure is discarded (baseline: ${SWALLOW_BASELINE.androidExecutedThroughThen})`
    );
    for (const t of throughThen) {
      lines.push(
        `      ${t.scenario.featureFile} :: "${t.scenario.title}"\n` +
          `        "${t.step}"  →  ${t.swallow.file}:${t.swallow.line}`
      );
    }
  }
  lines.push(
    failed
      ? "\nFAILED: swallowed-failure baseline exceeded."
      : "\nPASSED: swallowed-failure counts are at or below baseline."
  );
  if (!asJson) console.log(lines.join("\n"));
  return failed;
}

function main() {
  const asJson = process.argv.includes("--json");
  const platforms = parsePlatformArg();

  const allFindings: SilentStepFinding[] = [];
  if (platforms.includes("desktop-backend")) allFindings.push(...auditDesktopBackendSteps());
  if (platforms.includes("android")) allFindings.push(...auditAndroidSteps());

  const swallowing = auditSwallowingSteps(platforms);
  const throughThen = platforms.includes("android")
    ? androidScenariosThroughSwallow(loadAllScenarios(), swallowing, true)
    : [];

  if (asJson) {
    console.log(JSON.stringify({ silent: allFindings, swallowing, androidExecutedThroughSwallowingThen: throughThen.map((t) => ({ feature: t.scenario.featureFile, scenario: t.scenario.title, step: t.step, definition: `${t.swallow.file}:${t.swallow.line}` })) }, null, 2));
  } else {
    console.log("Silent-pass step audit (#709)\n");
  }

  if (process.argv.includes("--write-baseline")) {
    if (platforms.length !== 2) {
      console.error("--write-baseline rewrites the whole baseline; do not combine it with --platform.");
      process.exit(1);
    }
    writeSilentBaseline(allFindings);
    console.log(`Wrote ${relative(ROOT, SILENT_BASELINE_PATH)}`);
    return;
  }

  const baseline = loadSilentBaseline();
  let failed = false;
  for (const platform of platforms) {
    const findings = allFindings.filter((f) => f.platform === platform);
    const gate = evaluateSilentGate(findings, baseline);
    const over = gate.unexpected.length > 0;
    if (over) failed = true;

    if (!asJson) {
      console.log(
        `  [${over ? "FAIL" : "ok"}] ${platform}: ${findings.length} silent step(s), ` +
          `${gate.exempted.length} exempt, ${gate.unexpected.length} not in the baseline`
      );
      for (const f of gate.unexpected) {
        console.log(`      NEW  ${f.file}:${f.line}  @${f.keyword}("${f.pattern}")  — ${f.reason}`);
      }
      if (over) {
        console.log(
          "      A step was added without an assertion, or lost the one it had. Fix the step. If it is" +
            " deliberately empty, add it to `exempt` in silent-steps.baseline.json WITH a reason; do not" +
            " regenerate the baseline to make a red run green."
        );
      }
      for (const k of gate.stale.filter((k) => k.startsWith(`${platform} ::`))) {
        console.log(`      stale baseline entry (fixed - lock it in with --write-baseline): ${k}`);
      }
    }
  }

  if (!asJson) {
    console.log(
      failed
        ? "\nFAILED: a silent-pass step is not in the baseline."
        : "\nPASSED: every silent-pass step is accounted for in the baseline."
    );
  }

  const swallowFailed = reportSwallowing(platforms, swallowing, throughThen, asJson);
  if (swallowFailed) failed = true;

  process.exit(failed ? 1 : 0);
}

export const __testing = {
  findBodyOpenBrace,
  extractBracedBody,
  stripComments,
  hasAssertion,
  TS_ASSERTION_RE,
  KOTLIN_ASSERTION_RE,
  TS_VACUOUS_ASSERTIONS,
  KOTLIN_VACUOUS_ASSERTIONS,
  SWALLOW_BASELINE,
  findSwallow,
};

if (import.meta.main) {
  main();
}
