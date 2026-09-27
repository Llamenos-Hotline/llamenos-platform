#!/usr/bin/env bun
/**
 * CI Validation Script for BDD Test Coverage (Multi-Platform)
 *
 * Parses all .feature files in packages/test-specs/features/,
 * extracts scenario titles, and verifies that each scenario has
 * a corresponding implementation on the target platform(s).
 *
 * Platforms:
 *   android — Cucumber step defs (Kotlin @Given/@When/@Then), real phrase matching
 *   desktop — playwright-bdd step definitions, real Cucumber-expression matching
 *   backend — playwright-bdd step definitions, real Cucumber-expression matching
 *   ios     — exact Swift test-method name, in a target a merge-gating CI job runs (see checkIosCoverage)
 *
 * Desktop/backend matching semantics
 * -----------------------------------
 * playwright-bdd (see node_modules/playwright-bdd/dist/steps/stepDefinition.js
 * and dist/steps/finder.js) binds each Gherkin step to a step definition by
 * compiling the definition's string pattern into a `CucumberExpression`
 * (from `@cucumber/cucumber-expressions`, playwright-bdd's own matching
 * engine) and testing it against the step text.
 *
 * playwright-bdd *can* additionally filter candidates by keyword type
 * (Given↔Context, When↔Action, Then↔Outcome, with And/But inheriting the
 * previous step's type) — but only when the project config sets
 * `matchKeywords: true`. This repo's `playwright.config.ts` does not set
 * it (verified: no `matchKeywords` reference anywhere in the repo), so the
 * real runner matches purely by pattern text, Given/When/Then/And/But all
 * interchangeable against the same step-definition pool. That's also
 * documented in-repo: see the comment in
 * `tests/steps/security/sas-verification-steps.ts` ("Used as both Given
 * and When — playwright-bdd matches Given/When/Then interchangeably").
 * We replicate that: keyword is ignored entirely and every step is matched
 * against every parsed step definition regardless of keyword.
 *
 * We import the real `@cucumber/cucumber-expressions` package (a transitive
 * dependency of playwright-bdd, already in node_modules) and construct a
 * `CucumberExpression` per parsed step definition, so `{int}`, `{string}`,
 * `{word}`, `{float}`, escaped literals (`\(`, `\)`, `\/`), and anchoring
 * are handled with the exact same engine the test runner uses — not a
 * hand-rolled regex approximation.
 *
 * What this DOES catch:
 *   - A scenario whose step text has no matching registered step definition
 *     text/keyword-type on the target platform. playwright.config.ts runs
 *     every BDD project with `missingSteps: "fail-on-gen"`, so `bunx bddgen`
 *     itself refuses such a scenario; this tool reports the same condition
 *     for every platform in one pass, without generating specs (#1153).
 *   - A `@wip` / `@fixme` / `@skip` tag with no linked issue — those tags are
 *     the only sanctioned way to take a scenario out of a run, so each one
 *     must name the issue that owns it (see findUntrackedSkipTags).
 *   - Deleting/renaming step definition files (proven via the delete
 *     experiment in the PR description).
 *   - Scenario Outline steps, via first-row Examples substitution (see
 *     "What this DOES NOT catch" below for the exact limitation).
 *
 * What this DOES NOT catch:
 *   - Whether the *body* of a matched step definition is correct/complete
 *     (e.g. a step registered with the right phrase but an empty or wrong
 *     implementation still counts as "covered" — this tool measures
 *     phrase-level binding, not assertion quality).
 *   - Scenario Outline rows beyond the first Examples row — only the first
 *     row's values are substituted for `<placeholder>` tokens before
 *     matching, so a step whose match validity depends on a later row's
 *     value (e.g. a numeric parameter type that only fails to parse for a
 *     non-numeric example in row 3) will not be flagged.
 *   - Step definitions registered with a `RegExp` literal (`Given(/.../, ...)`)
 *     instead of a string Cucumber Expression — none currently exist in
 *     `tests/steps/`, but if one is added, this parser will not detect it
 *     as a step definition (its `Given(`/`When(`/`Then(` regex only
 *     extracts quoted string literals).
 *   - Custom Cucumber parameter types defined via `defineParameterType()` —
 *     none currently exist in the repo (verified), so the default
 *     `ParameterTypeRegistry` (built-in `{int}`, `{float}`, `{string}`,
 *     `{word}`) is sufficient. If a custom parameter type is added later
 *     without updating this tool, expressions using it will fail to match
 *     here even though the real runner would resolve them correctly.
 *   - Runtime-only failures: a step that matches syntactically but throws,
 *     times out, or asserts incorrectly at test execution time is outside
 *     this tool's scope entirely — it verifies binding, not pass/fail.
 *
 * Usage:
 *   bun run test-specs:validate                  # All platforms with implementations
 *   bun run test-specs:validate --platform android
 *   bun run test-specs:validate --platform desktop
 *   bun run test-specs:validate --platform ios
 *   bun run test-specs:validate --platform all
 *
 * Exit codes:
 *   0 — all scenarios have matching tests (or coverage is at/above threshold)
 *   1 — coverage is below the required threshold for a validated platform,
 *       or a @wip/@fixme/@skip tag has no linked issue
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { CucumberExpression, ParameterTypeRegistry } from "@cucumber/cucumber-expressions";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../..");
const FEATURES_DIR = join(__dirname, "../features");
const ANDROID_TEST_DIR = join(
  ROOT,
  "apps/android/app/src/androidTest/java/org/llamenos/hotline"
);
const IOS_TEST_DIR = join(ROOT, "apps/ios/Tests");
const DESKTOP_STEPS_DIR = join(ROOT, "tests/steps");
const BACKEND_STEPS_DIR = join(ROOT, "tests/steps/backend");

export type Platform = "android" | "desktop" | "ios" | "backend";

export interface Scenario {
  title: string;
  featureFile: string;
  featureName: string;
  featureTags: string[];
  scenarioTags: string[];
  allTags: string[];
  isOutline: boolean;
}

interface TestMethod {
  name: string;
  file: string;
  className: string;
}

// ---- CLI argument parsing ----

function parsePlatformArg(): Platform[] {
  const args = process.argv.slice(2);
  const platformIdx = args.indexOf("--platform");
  if (platformIdx === -1 || !args[platformIdx + 1]) {
    // Default: validate all platforms that have test directories
    const platforms: Platform[] = [];
    if (existsSync(join(ANDROID_TEST_DIR, "e2e")) || existsSync(join(ANDROID_TEST_DIR, "steps"))) {
      platforms.push("android");
    }
    if (existsSync(DESKTOP_STEPS_DIR)) {
      platforms.push("desktop");
    }
    if (existsSync(BACKEND_STEPS_DIR)) {
      platforms.push("backend");
    }
    if (existsSync(IOS_TEST_DIR) && findFiles(IOS_TEST_DIR, ".swift").length > 0) {
      platforms.push("ios");
    }
    return platforms.length > 0 ? platforms : ["android"];
  }

  const value = args[platformIdx + 1];
  if (value === "all") return ["android", "desktop", "ios", "backend"];
  if (["android", "desktop", "ios", "backend"].includes(value)) return [value as Platform];
  console.error(`Unknown platform: ${value}. Use: android, desktop, ios, backend, all`);
  process.exit(1);
}

// ---- Feature file parsing ----

export function findFiles(dir: string, ext: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      if (statSync(fullPath).isDirectory()) {
        files.push(...findFiles(fullPath, ext));
      } else if (entry.endsWith(ext)) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory may not exist
  }
  return files;
}

function parseTags(line: string): string[] {
  return line
    .split(/\s+/)
    .filter((t) => t.startsWith("@"))
    .map((t) => t.slice(1));
}

export function parseFeatureFile(path: string, featuresDir = FEATURES_DIR): Scenario[] {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  const scenarios: Scenario[] = [];
  let featureName = "";
  const featureTags: string[] = [];
  let pendingTags: string[] = [];
  let featureTagsParsed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Collect tags before Feature: line (Gherkin allows several tag lines)
    if (line.startsWith("@") && !featureTagsParsed) {
      featureTags.push(...parseTags(line));
      continue;
    }

    // Collect feature name
    if (line.startsWith("Feature:")) {
      featureName = line.replace("Feature:", "").trim();
      featureTagsParsed = true;
      continue;
    }

    // Collect tags before Scenario
    if (line.startsWith("@") && featureTagsParsed) {
      pendingTags.push(...parseTags(line));
      continue;
    }

    // Match Scenario or Scenario Outline
    const scenarioMatch = line.match(
      /^Scenario(?:\s+Outline)?:\s*(.+)$/
    );
    if (scenarioMatch) {
      const allTags = [...new Set([...featureTags, ...pendingTags])];
      scenarios.push({
        title: scenarioMatch[1].trim(),
        featureFile: relative(featuresDir, path),
        featureName,
        featureTags,
        scenarioTags: [...pendingTags],
        allTags,
        isOutline: line.startsWith("Scenario Outline"),
      });
      pendingTags = [];
      continue;
    }

    // Tags attach to the next keyword line; comments and blank lines between
    // them do not detach them. Any other line (Rule:, Background:, a step) does.
    if (line !== "" && !line.startsWith("#")) {
      pendingTags = [];
    }
  }

  return scenarios;
}

/**
 * Platform tag filters, replicating the scenario selection that actually
 * runs in `playwright.config.ts` (`defineBddProject({ tags: ... })`).
 * A scenario tagged e.g. `@desktop @wip` never runs on desktop in CI, so
 * counting it in the desktop denominator would understate real coverage.
 *
 * NOTE: these must be kept in sync with playwright.config.ts by hand — there
 * is no shared source of truth between the two today.
 */
const PLATFORM_EXCLUDE_TAGS: Partial<Record<Platform, string[]>> = {
  desktop: ["backend", "wip", "fixme", "requires-camera", "requires-live-calls", "requires-demo"],
  backend: ["wip", "fixme"],
};

export function scenariosForPlatform(scenarios: Scenario[], platform: Platform): Scenario[] {
  const excludeTags = PLATFORM_EXCLUDE_TAGS[platform] ?? [];
  return scenarios.filter(
    (s) => s.allTags.includes(platform) && !excludeTags.some((t) => s.allTags.includes(t))
  );
}

// ---- Scenario title to method name conversion ----

function scenarioToMethodName(title: string): string {
  return title
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .split(/\s+/)
    .map((word, i) =>
      i === 0
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join("");
}

function scenarioToSwiftMethod(title: string): string {
  const camel = scenarioToMethodName(title);
  return "test" + camel.charAt(0).toUpperCase() + camel.slice(1);
}

// ---- Platform-specific test file parsing ----

function parseKotlinTestFile(path: string): TestMethod[] {
  const content = readFileSync(path, "utf-8");
  const methods: TestMethod[] = [];
  const classMatch = content.match(/class\s+(\w+)/);
  const className = classMatch?.[1] ?? basename(path, ".kt");

  // Match @Test fun methods (JUnit-style)
  const methodRegex = /@Test\s*\n\s*fun\s+(\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = methodRegex.exec(content)) !== null) {
    methods.push({
      name: match[1],
      file: relative(ANDROID_TEST_DIR, path),
      className,
    });
  }

  return methods;
}

/**
 * Parse Cucumber step phrases from a Kotlin step definition file.
 * Extracts strings from @Given, @When, @Then, @And, @But annotations.
 */
function parseCucumberStepPhrases(path: string): string[] {
  const content = readFileSync(path, "utf-8");
  const phrases: string[] = [];

  // Match @Given("..."), @When("..."), @Then("..."), @And("..."), @But("...")
  const stepRegex = /@(?:Given|When|Then|And|But)\("([^"]+)"\)/g;
  let match: RegExpExecArray | null;
  while ((match = stepRegex.exec(content)) !== null) {
    phrases.push(match[1]);
  }

  return phrases;
}

/**
 * Check if a Gherkin step text matches a Cucumber step phrase pattern.
 * Handles Cucumber expression parameters like {string}, {int}, {word},
 * escaped characters like \\(, and DataTable steps (ending with :).
 */
function stepMatchesCucumberPhrase(gherkinStep: string, cucumberPhrase: string): boolean {
  const step = gherkinStep.trim();

  // Convert cucumber expression pattern to regex
  // Step 1: Unescape Kotlin string escapes (source file \\\\ → JS string \\)
  // Step 2: Single-pass — handle Cucumber escapes, parameters, and regex-escape
  //         everything else simultaneously (avoids double-escaping from
  //         unescape-then-re-escape chains)
  const pattern = cucumberPhrase
    .replace(/\\\\/g, "\\")
    .replace(/\\[\/()]|\{(?:string|int|word)\}|[.*+?^${}()|\\[\]]/g, (match) => {
      switch (match) {
        // Cucumber expression escapes → regex equivalents
        case '\\/': return '/'
        case '\\(': return '\\('
        case '\\)': return '\\)'
        // Cucumber expression parameters → regex patterns
        case '{string}': return '"[^"]*"'
        case '{int}': return '\\d+'
        case '{word}': return '\\S+'
        // Regex special characters → escaped
        default: return '\\' + match
      }
    })
    ;

  try {
    const regex = new RegExp(`^${pattern}$`);
    return regex.test(step);
  } catch {
    // If regex construction fails, fall back to exact match
    return step === cucumberPhrase;
  }
}

// ---- Gherkin step extraction (shared by android fuzzy-phrase + desktop/backend expression matching) ----

interface RawStepLine {
  keyword: "Given" | "When" | "Then" | "And" | "But";
  text: string;
}

/**
 * Extract the raw Given/When/Then/And/But step lines for one scenario,
 * including any Background steps that apply to it, and substitute the first
 * Examples row's values into `<placeholder>` tokens for Scenario Outlines.
 *
 * Background scoping follows Gherkin: a Feature-level Background applies to
 * every scenario in the file, a Background inside a `Rule:` applies only to
 * the scenarios of that Rule. Treating a Rule's Background as file-wide made
 * this tool report scenarios in *other* Rules as unbound when playwright-bdd
 * binds and runs them (admin/ban-management.feature, #1153).
 *
 * LIMITATION: only the first Examples row is used for substitution — see
 * the "What this DOES NOT catch" note at the top of this file.
 */
function extractRawScenarioSteps(featurePath: string, scenarioTitle: string): RawStepLine[] {
  const content = readFileSync(featurePath, "utf-8");
  const lines = content.split("\n");

  const featureBackgroundSteps: RawStepLine[] = [];
  let ruleBackgroundSteps: RawStepLine[] = [];
  let targetRuleBackgroundSteps: RawStepLine[] = [];
  const scenarioSteps: RawStepLine[] = [];
  const exampleTableRows: string[][] = [];

  let inRule = false;
  let inBackground = false;
  let inTargetScenario = false;
  let inExamplesTable = false;
  let sawTargetScenario = false;

  const stepLineRe = /^(Given|When|Then|And|But)\s+(.+)$/;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("Rule:")) {
      if (sawTargetScenario) break; // moved past our scenario into the next Rule
      inRule = true;
      ruleBackgroundSteps = [];
      inBackground = false;
      inTargetScenario = false;
      inExamplesTable = false;
      continue;
    }

    if (trimmed.startsWith("Background:")) {
      inBackground = true;
      inTargetScenario = false;
      inExamplesTable = false;
      continue;
    }

    const scenarioMatch = trimmed.match(/^Scenario(?:\s+Outline)?:\s*(.+)$/);
    if (scenarioMatch) {
      inBackground = false;
      inExamplesTable = false;
      inTargetScenario = scenarioMatch[1].trim() === scenarioTitle;
      if (inTargetScenario) {
        sawTargetScenario = true;
        targetRuleBackgroundSteps = ruleBackgroundSteps;
      } else if (sawTargetScenario) break; // moved past our scenario into the next one
      continue;
    }

    if (trimmed.startsWith("Examples:")) {
      inExamplesTable = inTargetScenario;
      continue;
    }

    if (trimmed.startsWith("|")) {
      if (inExamplesTable) {
        const cells = trimmed
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim());
        exampleTableRows.push(cells);
      }
      continue;
    }

    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("@") || trimmed.startsWith("Feature:")) {
      continue;
    }

    const stepMatch = trimmed.match(stepLineRe);
    if (stepMatch) {
      const step: RawStepLine = { keyword: stepMatch[1] as RawStepLine["keyword"], text: stepMatch[2] };
      if (inBackground) (inRule ? ruleBackgroundSteps : featureBackgroundSteps).push(step);
      else if (inTargetScenario) scenarioSteps.push(step);
    }
  }

  // Scenario Outline: substitute first Examples data row into <placeholder> tokens.
  let resolvedScenarioSteps = scenarioSteps;
  if (exampleTableRows.length >= 2) {
    const [header, firstRow] = exampleTableRows;
    resolvedScenarioSteps = scenarioSteps.map((step) => {
      let text = step.text;
      header.forEach((placeholderName, idx) => {
        text = text.split(`<${placeholderName}>`).join(firstRow[idx] ?? "");
      });
      return { ...step, text };
    });
  }

  return [...featureBackgroundSteps, ...targetRuleBackgroundSteps, ...resolvedScenarioSteps];
}

/** Legacy string-only accessor, kept for the Android Cucumber matcher which does plain text matching. */
function extractScenarioSteps(featurePath: string, scenarioTitle: string): string[] {
  return extractRawScenarioSteps(featurePath, scenarioTitle).map((s) => s.text);
}

// ---- Real playwright-bdd step definition parsing + matching ----

interface PlaywrightBddStepDef {
  keyword: "Given" | "When" | "Then";
  pattern: string;
  file: string;
  expression: CucumberExpression | null;
  parseError?: string;
}

/**
 * playwright-bdd's default `ParameterTypeRegistry` contains only Cucumber's
 * built-in parameter types ({int}, {float}, {string}, {word}, {}, etc).
 * `tests/steps/**` defines no custom parameter types via
 * `defineParameterType()` (verified with `grep -rn defineParameterType
 * tests/`), so a fresh registry has identical semantics to the one the
 * real test run uses.
 */
function newParameterTypeRegistry(): ParameterTypeRegistry {
  return new ParameterTypeRegistry();
}

/**
 * Parse `Given(...)`, `When(...)`, `Then(...)` calls with a quoted string
 * pattern (Cucumber Expression) out of a step definition file. Multi-line
 * calls are supported (the pattern is often on its own line). Step
 * definitions registered with a RegExp literal instead of a string are not
 * detected — see the "What this DOES NOT catch" note at the top of the
 * file.
 */
function parsePlaywrightBddStepDefs(path: string, registry: ParameterTypeRegistry): PlaywrightBddStepDef[] {
  const content = readFileSync(path, "utf-8");
  const defs: PlaywrightBddStepDef[] = [];

  // Matches Given(/When(/Then( followed by a single- or double-quoted string,
  // honoring backslash-escaped characters within the string (so `\(` and
  // `\'`/`\"` don't terminate the match early).
  const callRe = /\b(Given|When|Then)\s*\(\s*(['"])((?:\\.|(?!\2)[\s\S])*)\2/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(content)) !== null) {
    const keyword = match[1] as PlaywrightBddStepDef["keyword"];
    const pattern = unescapeJsStringLiteral(match[3], match[2]);
    let expression: CucumberExpression | null = null;
    let parseError: string | undefined;
    try {
      expression = new CucumberExpression(pattern, registry);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    defs.push({ keyword, pattern, file: relative(ROOT, path), expression, parseError });
  }

  return defs;
}

/** Undo JS string-literal escaping (\\ -> \, \' -> ', \" -> ") to get the runtime string value. */
function unescapeJsStringLiteral(raw: string, quote: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === "\\" || next === quote || next === "'" || next === '"') {
        out += next;
      } else if (next === "n") {
        out += "\n";
      } else if (next === "t") {
        out += "\t";
      } else {
        out += next;
      }
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Match a Gherkin step's text against a registered step definition's
 * Cucumber Expression. Keyword (Given/When/Then/And/But) is intentionally
 * NOT used as a filter — see the "Desktop/backend matching semantics" note
 * at the top of this file for why that mirrors this repo's actual
 * playwright-bdd configuration (`matchKeywords` is not enabled).
 */
function findMatchingStepDef(
  stepText: string,
  defs: PlaywrightBddStepDef[]
): PlaywrightBddStepDef | undefined {
  return defs.find((def) => def.expression !== null && def.expression.match(stepText) !== null);
}

// ---- Coverage checking per platform ----

function checkAndroidCoverage(scenarios: Scenario[]): { covered: number; missing: number } {
  const stepsDir = join(ANDROID_TEST_DIR, "steps");
  const e2eDir = join(ANDROID_TEST_DIR, "e2e");
  const useCucumber = existsSync(stepsDir) && findFiles(stepsDir, "Steps.kt").length > 0;

  if (useCucumber) {
    return checkAndroidCucumberCoverage(scenarios);
  }

  // Legacy: @Test method matching
  const testDirs = [e2eDir, stepsDir];
  const allMethods: TestMethod[] = [];

  for (const dir of testDirs) {
    const files = findFiles(dir, "Test.kt").concat(findFiles(dir, "Steps.kt"));
    for (const file of files) {
      allMethods.push(...parseKotlinTestFile(file));
    }
  }

  console.log(
    `  Found ${allMethods.length} Android @Test methods across ${new Set(allMethods.map(m => m.file)).size} test files\n`
  );

  let covered = 0;
  let missing = 0;
  let currentFeature = "";

  for (const scenario of scenarios) {
    if (scenario.featureFile !== currentFeature) {
      currentFeature = scenario.featureFile;
      console.log(`  Feature: ${scenario.featureName} (${scenario.featureFile})`);
    }

    const expectedMethod = scenarioToMethodName(scenario.title);
    const method = allMethods.find((m) => m.name === expectedMethod);

    if (method) {
      console.log(
        `    ✓ ${scenario.title}\n      ${method.className}.${method.name}`
      );
      covered++;
    } else {
      // Fuzzy match
      const fuzzyMatch = allMethods.find((m) =>
        m.name.toLowerCase().includes(expectedMethod.slice(0, 20).toLowerCase())
      );
      if (fuzzyMatch) {
        console.log(
          `    ~ ${scenario.title}\n      ${fuzzyMatch.className}.${fuzzyMatch.name} (fuzzy match)`
        );
        covered++;
      } else {
        console.log(
          `    ✗ ${scenario.title}\n      MISSING (expected: ${expectedMethod})`
        );
        missing++;
      }
    }
  }

  return { covered, missing };
}

/**
 * Cucumber-specific coverage check for Android.
 *
 * With Cucumber, coverage is verified by checking that every Gherkin step
 * phrase in @android-tagged feature files has a matching step definition
 * in the steps/ directory. Scenarios are covered when all their steps
 * have matching definitions.
 *
 * NOTE: this uses a hand-rolled regex approximation of Cucumber Expression
 * matching (`stepMatchesCucumberPhrase`), not the real `@cucumber/
 * cucumber-expressions` engine used for desktop/backend below — Android's
 * Cucumber runtime is JVM-based (io.cucumber:cucumber-java), not
 * playwright-bdd, so the JS library's exact behavior doesn't apply here.
 * It supports {string}/{int}/{word} and \(-style escapes, which covers
 * every parameter type actually used in `apps/android/.../steps/*.kt`.
 */
function checkAndroidCucumberCoverage(scenarios: Scenario[]): { covered: number; missing: number } {
  const stepsDir = join(ANDROID_TEST_DIR, "steps");
  const stepFiles = findFiles(stepsDir, ".kt");

  // Collect all cucumber step phrases from step definition files
  const allPhrases: string[] = [];
  for (const file of stepFiles) {
    allPhrases.push(...parseCucumberStepPhrases(file));
  }

  console.log(
    `  Cucumber mode: Found ${allPhrases.length} step definitions across ${stepFiles.length} step files\n`
  );

  let covered = 0;
  let missing = 0;
  let currentFeature = "";

  for (const scenario of scenarios) {
    if (scenario.featureFile !== currentFeature) {
      currentFeature = scenario.featureFile;
      console.log(`  Feature: ${scenario.featureName} (${scenario.featureFile})`);
    }

    // Extract all Gherkin steps for this scenario from the feature file
    const featurePath = join(FEATURES_DIR, scenario.featureFile);
    const gherkinSteps = extractScenarioSteps(featurePath, scenario.title);

    if (gherkinSteps.length === 0) {
      // No steps extracted — could be an outline with examples or empty scenario
      console.log(`    ✓ ${scenario.title} (no steps to validate)`);
      covered++;
      continue;
    }

    // Check each step has a matching definition
    const unmatchedSteps: string[] = [];
    for (const step of gherkinSteps) {
      const hasMatch = allPhrases.some((phrase) =>
        stepMatchesCucumberPhrase(step, phrase)
      );
      if (!hasMatch) {
        unmatchedSteps.push(step);
      }
    }

    if (unmatchedSteps.length === 0) {
      console.log(
        `    ✓ ${scenario.title} (${gherkinSteps.length} steps matched)`
      );
      covered++;
    } else {
      console.log(
        `    ✗ ${scenario.title}\n      Missing step defs for:`
      );
      for (const step of unmatchedSteps) {
        console.log(`        - ${step}`);
      }
      missing++;
    }
  }

  return { covered, missing };
}

/**
 * Real coverage check for playwright-bdd platforms (desktop, backend).
 *
 * For each scenario: extract its resolved Gherkin steps (background +
 * scenario, outline placeholders substituted from the first Examples row),
 * and check that some registered step definition's `CucumberExpression`
 * matches the step text — keyword-agnostic, exactly as playwright-bdd
 * binds steps in this repo's configuration (see file header).
 *
 * A scenario is "covered" only if every one of its steps matches. This
 * mirrors the real runtime: `missingSteps: "skip-scenario"` skips the
 * *entire* scenario if even one step has no binding.
 */
function checkPlaywrightBddCoverage(
  scenarios: Scenario[],
  stepsDir: string,
  label: string,
  featuresDir: string = FEATURES_DIR
): { covered: number; missing: number } {
  if (!existsSync(stepsDir)) {
    console.log(`  ${label} step definitions not yet created (${relative(ROOT, stepsDir)}/)`);
    console.log(`  ${scenarios.length} scenarios pending implementation\n`);
    return { covered: 0, missing: scenarios.length };
  }

  const stepFiles = findFiles(stepsDir, ".ts");
  const registry = newParameterTypeRegistry();
  const allDefs: PlaywrightBddStepDef[] = [];
  for (const file of stepFiles) {
    allDefs.push(...parsePlaywrightBddStepDefs(file, registry));
  }

  const parseErrors = allDefs.filter((d) => d.parseError);
  console.log(
    `  Found ${allDefs.length} ${label} step definitions across ${stepFiles.length} step files` +
      (parseErrors.length ? ` (${parseErrors.length} failed to parse as Cucumber Expressions)` : "") +
      "\n"
  );
  for (const d of parseErrors) {
    console.log(`    WARNING: could not parse pattern in ${d.file}: "${d.pattern}" — ${d.parseError}`);
  }

  let covered = 0;
  let missing = 0;
  let currentFeature = "";

  for (const scenario of scenarios) {
    if (scenario.featureFile !== currentFeature) {
      currentFeature = scenario.featureFile;
      console.log(`  Feature: ${scenario.featureName} (${scenario.featureFile})`);
    }

    const featurePath = join(featuresDir, scenario.featureFile);
    const steps = extractRawScenarioSteps(featurePath, scenario.title).map((s) => s.text);

    if (steps.length === 0) {
      console.log(`    ✓ ${scenario.title} (no steps to validate)`);
      covered++;
      continue;
    }

    const unmatchedSteps: string[] = [];
    for (const stepText of steps) {
      if (!findMatchingStepDef(stepText, allDefs)) {
        unmatchedSteps.push(stepText);
      }
    }

    if (unmatchedSteps.length === 0) {
      console.log(`    ✓ ${scenario.title} (${steps.length} steps matched)`);
      covered++;
    } else {
      console.log(`    ✗ ${scenario.title}\n      Missing step defs for:`);
      for (const step of unmatchedSteps) {
        console.log(`        - ${step}`);
      }
      missing++;
    }
  }

  return { covered, missing };
}

function checkDesktopCoverage(scenarios: Scenario[]): { covered: number; missing: number } {
  return checkPlaywrightBddCoverage(scenarios, DESKTOP_STEPS_DIR, "desktop");
}

function checkBackendCoverage(scenarios: Scenario[]): { covered: number; missing: number } {
  return checkPlaywrightBddCoverage(scenarios, BACKEND_STEPS_DIR, "backend");
}

// ---- iOS ----
//
// iOS has no Gherkin runner: no feature file is bundled, parsed or executed by
// the iOS test targets. The only link between a scenario and iOS is a naming
// convention — a Swift test method called `test` + PascalCase(scenario title).
// A scenario is covered on iOS only when ALL of these hold:
//
//   1. A test method has exactly that name. There is no fuzzy fallback. The
//      old 20-character substring fallback credited `Switch active hub` to
//      `testBackgroundPushForHubBDoesNotSwitchActiveHubFromHubA` — a test
//      asserting the active hub is NOT switched — and credited
//      `Wrong PIN shows error` to the one method that already covered
//      `Wrong PIN shows error on unlock` (#1221).
//   2. XCTest actually runs it: a parameterless, non-private `test*` method of
//      an XCTestCase subclass (directly or via e.g. BaseUITest), or a Swift
//      Testing `@Test` function, with no `XCTSkip` in its body — and the body
//      can fail: it makes at least one assertion, and none of them is
//      `XCTAssertTrue(true…)` (the "pass gracefully" branch 29 iOS UI tests use).
//   3. Its file belongs to a test target that the `Llamenos` scheme's test
//      action includes (apps/ios/project.yml). #168 removed LlamenosUITests
//      from that list; for four months no UI test could run, anywhere.
//   4. A merge-gating CI job executes that target: a job in `ci-status`'s
//      `needs` (see iosTargetsGatedByCi). 13 of the 30 scenarios the old
//      matcher credited were in a target ci.yml passed -skip-testing for.
//   5. No other @ios scenario maps to the same method name: one test is
//      credited to at most one scenario.
//
// This measures that a correctly-named, CI-executed test EXISTS. Whether it
// passes is decided by the CI job that runs it, and whether its assertions
// match the scenario's Then-steps is a review question this tool cannot
// answer.

const IOS_ROOT = join(ROOT, "apps/ios");
const IOS_PROJECT_YML = join(IOS_ROOT, "project.yml");
const WORKFLOWS_DIR = join(ROOT, ".github/workflows");
/** The scheme every iOS CI job builds and tests through (xcodegen: the app target's scheme). */
const IOS_SCHEME = "Llamenos";
/** Aggregate job whose `needs` list is the required merge gate. */
const CI_GATE_JOB = "ci-status";
/**
 * The UI target is run class-by-class through apps/ios/scripts/ui-tests.py,
 * whose `shard` subcommand assigns every XCTestCase subclass under Tests/UI to
 * exactly one shard — so a job running it runs the whole target.
 */
const IOS_UI_TARGET = "LlamenosUITests";
const IOS_UI_SHARD_COMMAND = /\bui-tests\.py shard\b/;

type XcodegenSource = string | { path: string };
type XcodegenTestTarget = string | { name: string };
interface XcodegenProject {
  targets?: Record<
    string,
    { type?: string; sources?: XcodegenSource[]; scheme?: { testTargets?: XcodegenTestTarget[] } }
  >;
}

interface WorkflowStep {
  run?: string;
}
interface WorkflowJob {
  needs?: string | string[];
  uses?: string;
  steps?: WorkflowStep[];
}
interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

export interface IosTestTarget {
  name: string;
  /** Source directories, relative to apps/ios. */
  sourceDirs: string[];
  /** Member of the `Llamenos` scheme's test action. */
  inScheme: boolean;
}

export interface IosTestMethod {
  name: string;
  /** Path relative to apps/ios. */
  file: string;
  className: string;
  /** Test target owning the file, if any. */
  target: string | undefined;
  /** Why it earns no scenario credit even when correctly named, if it does not. */
  disqualified?: string;
}

export interface IosCoveragePaths {
  iosRoot: string;
  projectYml: string;
  workflowsDir: string;
}

const DEFAULT_IOS_PATHS: IosCoveragePaths = {
  iosRoot: IOS_ROOT,
  projectYml: IOS_PROJECT_YML,
  workflowsDir: WORKFLOWS_DIR,
};

export function readIosTestTargets(projectYml: string): IosTestTarget[] {
  const project = Bun.YAML.parse(readFileSync(projectYml, "utf-8")) as XcodegenProject;
  const targets = project.targets ?? {};
  const schemeMembers = new Set(
    (targets[IOS_SCHEME]?.scheme?.testTargets ?? []).map((t) => (typeof t === "string" ? t : t.name))
  );
  return Object.entries(targets)
    .filter(([, t]) => t.type === "bundle.unit-test" || t.type === "bundle.ui-testing")
    .map(([name, t]) => ({
      name,
      sourceDirs: (t.sources ?? []).map((s) => (typeof s === "string" ? s : s.path)),
      inScheme: schemeMembers.has(name),
    }));
}

function readWorkflow(path: string): Workflow {
  return existsSync(path) ? (Bun.YAML.parse(readFileSync(path, "utf-8")) as Workflow) : {};
}

function asArray(needs: string | string[] | undefined): string[] {
  return needs === undefined ? [] : Array.isArray(needs) ? needs : [needs];
}

/**
 * Test targets a merge-gating CI job executes, mapped to the job that does.
 *
 * Read structurally from the parsed workflows on every run, so the credit
 * follows the CI wiring instead of a claim about it: taking a job out of
 * `ci-status`'s needs, switching the called workflow to dispatch-only (the
 * `uses:` job then no longer exists in ci.yml), or deleting the step that
 * runs a target removes that target's credit.
 *
 * A target counts when a gated job either runs `xcodebuild` with a
 * whole-target `-only-testing:<Target>`, or calls a reusable workflow one of
 * whose jobs runs the UI sharder (IOS_UI_SHARD_COMMAND).
 */
export function iosTargetsGatedByCi(workflowsDir: string): Map<string, string> {
  const ci = readWorkflow(join(workflowsDir, "ci.yml"));
  const jobs = ci.jobs ?? {};
  const gate = new Set(asArray(jobs[CI_GATE_JOB]?.needs));
  const gated = new Map<string, string>();

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!gate.has(jobName)) continue;
    for (const step of job.steps ?? []) {
      // `-only-testing:Target` selects the whole target; `Target/Class` would not.
      for (const m of (step.run ?? "").matchAll(/-only-testing:(\w+)(?![\w/])/g)) {
        gated.set(m[1], `ci.yml ${jobName}`);
      }
    }
    const local = job.uses?.match(/^\.\/\.github\/workflows\/([\w.-]+\.ya?ml)$/);
    if (local) {
      const called = readWorkflow(join(workflowsDir, local[1]));
      for (const [calledJobName, calledJob] of Object.entries(called.jobs ?? {})) {
        if ((calledJob.steps ?? []).some((s) => IOS_UI_SHARD_COMMAND.test(s.run ?? ""))) {
          gated.set(IOS_UI_TARGET, `ci.yml ${jobName} → ${local[1]} ${calledJobName}`);
        }
      }
    }
  }
  return gated;
}

const SWIFT_TYPE_RE =
  /^([ \t]*)(?:@\w+[ \t]+)*(?:(?:final|public|internal|open|private|fileprivate)[ \t]+)*(class|struct|actor|enum|extension)[ \t]+(\w+)(?:[ \t]*:[ \t]*(\w+))?/gm;
const SWIFT_TEST_FUNC_RE =
  /^([ \t]*)((?:@\w+(?:\([^)]*\))?[ \t]+)*)((?:(?:private|fileprivate|public|internal|open|override|final|nonisolated)[ \t]+)*)func[ \t]+(test\w*)[ \t]*\(([^)]*)\)/gm;

/**
 * Parse every Swift file under apps/ios/Tests into test methods, with the
 * target each file belongs to and, for methods that cannot earn scenario
 * credit, why. A method's body is approximated as the text up to the next
 * test method, which can only over-disqualify, never over-credit.
 */
export function parseIosTestMethods(iosRoot: string, targets: IosTestTarget[]): IosTestMethod[] {
  const files = findFiles(join(iosRoot, "Tests"), ".swift");
  const sources = files.map((path) => ({ path, content: readFileSync(path, "utf-8") }));

  // Inheritance across all test files, so `X: BaseUITest` resolves to XCTestCase.
  const superclass = new Map<string, string>();
  for (const { content } of sources) {
    for (const m of content.matchAll(SWIFT_TYPE_RE)) {
      if (m[2] === "class" && m[4]) superclass.set(m[3], m[4]);
    }
  }
  const isXCTestCase = (name: string): boolean => {
    const seen = new Set<string>();
    for (let c: string | undefined = name; c && !seen.has(c); c = superclass.get(c)) {
      seen.add(c);
      if (c === "XCTestCase") return true;
    }
    return false;
  };

  const methods: IosTestMethod[] = [];
  for (const { path, content } of sources) {
    const file = relative(iosRoot, path);
    const target = targets.find((t) => t.sourceDirs.some((d) => file.startsWith(`${d.replace(/\/$/, "")}/`)))?.name;
    // Brace matching is unreliable here (test files hold JSON string literals),
    // so a method belongs to the nearest preceding type declared LESS indented.
    const types = [...content.matchAll(SWIFT_TYPE_RE)].map((m) => ({
      index: m.index ?? 0,
      indent: m[1].length,
      name: m[3],
    }));
    const funcs = [...content.matchAll(SWIFT_TEST_FUNC_RE)];

    funcs.forEach((m, i) => {
      const start = m.index ?? 0;
      const end = i + 1 < funcs.length ? (funcs[i + 1].index ?? content.length) : content.length;
      const indent = m[1].length;
      const enclosing =
        types.filter((t) => t.index < start && t.indent < indent).at(-1)?.name ?? basename(path, ".swift");
      const attributes = m[2];
      const modifiers = m[3];
      const params = m[5].trim();
      const isSwiftTesting = /@Test\b/.test(attributes);

      const body = content.slice(start, end);
      let disqualified: string | undefined;
      if (/\b(?:private|fileprivate)\b/.test(modifiers)) disqualified = "private — XCTest does not run it";
      else if (params !== "" && !isSwiftTesting) disqualified = "takes parameters — XCTest does not run it";
      else if (!isSwiftTesting && !isXCTestCase(enclosing)) disqualified = `${enclosing} is not an XCTestCase`;
      else if (/\bXCTSkip\b/.test(body)) disqualified = "calls XCTSkip";
      else if (/\bXCTAssertTrue\(\s*true\b/.test(body)) disqualified = "contains XCTAssertTrue(true…) — a branch that cannot fail";
      // A thrown error fails the test, so `try` (not `try?`) is an assertion too.
      else if (!/(?:\b(?:XCTAssert\w*|XCTFail|XCTUnwrap)|#expect|#require)\s*\(|\btry(?:!|\s)/.test(body)) disqualified = "makes no assertion";

      methods.push({ name: m[4], file, className: enclosing, target, disqualified });
    });
  }
  return methods;
}

interface IosCoverageResult {
  covered: number;
  missing: number;
}

function checkIosCoverage(
  scenarios: Scenario[],
  paths: IosCoveragePaths = DEFAULT_IOS_PATHS
): IosCoverageResult {
  const targets = readIosTestTargets(paths.projectYml);
  const gated = iosTargetsGatedByCi(paths.workflowsDir);
  const methods = parseIosTestMethods(paths.iosRoot, targets);

  console.log(`  ${methods.length} Swift test methods under ${relative(ROOT, paths.iosRoot) || "."}/Tests`);
  for (const t of targets) {
    const scheme = t.inScheme ? `in the ${IOS_SCHEME} scheme` : `NOT in the ${IOS_SCHEME} scheme`;
    const ci = gated.get(t.name) ?? "run by NO merge-gating CI job";
    console.log(`  target ${t.name} (${t.sourceDirs.join(", ")}): ${scheme}; ${ci}`);
  }
  console.log();

  const byName = new Map<string, IosTestMethod[]>();
  for (const m of methods) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
  const claims = new Map<string, number>();
  for (const s of scenarios) {
    const name = scenarioToSwiftMethod(s.title);
    claims.set(name, (claims.get(name) ?? 0) + 1);
  }

  let covered = 0;
  let missing = 0;
  let currentFeature = "";
  const uncreditedNamed: string[] = [];

  for (const scenario of scenarios) {
    if (scenario.featureFile !== currentFeature) {
      currentFeature = scenario.featureFile;
      console.log(`  Feature: ${scenario.featureName} (${scenario.featureFile})`);
    }
    const expected = scenarioToSwiftMethod(scenario.title);
    const named = byName.get(expected) ?? [];
    const credited = named.find(
      (m) => !m.disqualified && m.target && targets.find((t) => t.name === m.target)?.inScheme && gated.has(m.target)
    );

    if (credited && (claims.get(expected) ?? 0) === 1) {
      console.log(`    ✓ ${scenario.title}\n      ${credited.className}.${credited.name} [${credited.target}]`);
      covered++;
      continue;
    }

    missing++;
    if (named.length === 0) {
      console.log(`    ✗ ${scenario.title}\n      MISSING (expected: ${expected})`);
      continue;
    }
    const reasons = named.map((m) => {
      const where = `${m.className}.${m.name} [${m.target ?? "no target"}]`;
      if (m.disqualified) return `${where}: ${m.disqualified}`;
      if (!m.target) return `${where}: file is in no test target`;
      if (!targets.find((t) => t.name === m.target)?.inScheme) return `${where}: target not in the ${IOS_SCHEME} scheme`;
      if (!gated.has(m.target)) return `${where}: target not run by any merge-gating CI job`;
      return `${where}: ${claims.get(expected)} @ios scenarios claim this one method name`;
    });
    uncreditedNamed.push(`${scenario.featureFile}: ${scenario.title}`);
    console.log(`    ✗ ${scenario.title}\n      NOT CREDITED — ${reasons.join("; ")}`);
  }

  if (uncreditedNamed.length > 0) {
    console.log(`\n  ${uncreditedNamed.length} scenario(s) have a correctly-named test that is not credited (reasons above).`);
  }
  console.log();
  return { covered, missing };
}

// ---- Tag & duplicate validation ----

function reportPlatformTagCounts(scenarios: Scenario[]) {
  const platformCounts: Record<string, number> = {
    android: 0,
    ios: 0,
    desktop: 0,
    backend: 0,
  };
  let untagged = 0;

  for (const s of scenarios) {
    let hasPlatformTag = false;
    for (const tag of s.allTags) {
      if (tag in platformCounts) {
        platformCounts[tag]++;
        hasPlatformTag = true;
      }
    }
    if (!hasPlatformTag) {
      untagged++;
    }
  }

  console.log("Scenario counts by platform tag:");
  for (const [tag, count] of Object.entries(platformCounts)) {
    if (count > 0) {
      console.log(`  @${tag}: ${count} scenarios`);
    }
  }
  if (untagged > 0) {
    console.log(`  WARNING: ${untagged} scenarios have NO platform tag`);
  }
  console.log();
}

function reportUntaggedFeatures(featureFiles: string[]) {
  const warnings: string[] = [];
  for (const file of featureFiles) {
    const content = readFileSync(file, "utf-8");
    // The feature's tag line may sit below comments (e.g. an `# @wip: ... — #N` note)
    const firstLine =
      content
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l !== "" && !l.startsWith("#")) ?? "";
    if (!firstLine.startsWith("@")) {
      warnings.push(relative(FEATURES_DIR, file));
    }
  }
  if (warnings.length > 0) {
    console.log(`WARNING: ${warnings.length} feature files missing platform tags:`);
    for (const w of warnings) {
      console.log(`  - ${w}`);
    }
    console.log();
  }
}

/**
 * Tags that take a scenario out of a run on purpose. `@wip` and `@fixme` are
 * excluded by every BDD project's tag filter in playwright.config.ts; `@skip`
 * and `@fixme` are also playwright-bdd special tags that render the test as
 * skipped without looking up its steps.
 */
const SKIP_TAGS = ["wip", "fixme", "skip"];

/** `#1234` (not an HTML entity or URL fragment) or a `.../issues/1234` URL. */
const ISSUE_REF_RE = /(?:^|[^\w&/])#\d+\b|\/issues\/\d+\b/;

export interface UntrackedSkipTag {
  featureFile: string;
  /** 1-indexed line of the tag line carrying the skip tag. */
  line: number;
  tags: string[];
  /** The Feature/Rule/Scenario/Examples line the tags apply to. */
  target: string;
}

/**
 * Every `@wip` / `@fixme` / `@skip` must name the issue that owns it (#1153).
 *
 * The BDD projects run with `missingSteps: "fail-on-gen"`, so an unbound
 * scenario can no longer drop out of a run silently — the only way out is one
 * of these tags. Without this rule the tag would just be the old silent skip
 * with an extra keystroke. With it, excluding a scenario is a recorded
 * decision someone can find and schedule.
 *
 * The reference goes in a comment in the annotation block that carries the
 * tag — the contiguous run of comment and tag lines directly above the
 * keyword line, with no blank line in between (the convention the existing
 * `@fixme`s already follow):
 *
 *   # @wip: step definitions not written yet — #1122
 *   @wip
 *   Scenario: ...
 */
export function findUntrackedSkipTags(path: string, featuresDir = FEATURES_DIR): UntrackedSkipTag[] {
  const lines = readFileSync(path, "utf-8").split("\n");
  const isComment = (l: string) => l.trim().startsWith("#");
  const isTagLine = (l: string) => l.trim().startsWith("@");
  const isAnnotation = (l: string) => isComment(l) || isTagLine(l);
  const untracked: UntrackedSkipTag[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!isTagLine(lines[i])) continue;
    const skipTags = parseTags(lines[i].trim()).filter((t) => SKIP_TAGS.includes(t));
    if (skipTags.length === 0) continue;

    let start = i;
    while (start > 0 && isAnnotation(lines[start - 1])) start--;
    let end = i;
    while (end + 1 < lines.length && isAnnotation(lines[end + 1])) end++;

    const hasIssueRef = lines
      .slice(start, end + 1)
      .filter(isComment)
      .some((l) => ISSUE_REF_RE.test(l.trim().replace(/^#/, "")));
    if (!hasIssueRef) {
      untracked.push({
        featureFile: relative(featuresDir, path),
        line: i + 1,
        tags: skipTags,
        target: lines[end + 1]?.trim() ?? "",
      });
    }
  }

  return untracked;
}

function reportUntrackedSkipTags(featureFiles: string[]): number {
  const untracked = featureFiles.flatMap((f) => findUntrackedSkipTags(f));
  if (untracked.length > 0) {
    console.log(
      `ERROR: ${untracked.length} @wip/@fixme/@skip tag(s) with no linked issue.\n` +
        `  Add a comment naming the owning issue directly above the tag, e.g.\n` +
        `    # @wip: <why it is excluded> — #1234\n`
    );
    for (const u of untracked) {
      console.log(`  - ${u.featureFile}:${u.line} @${u.tags.join(" @")} → ${u.target}`);
    }
    console.log();
  }
  return untracked.length;
}

function checkDuplicateFeatureNames(featureFiles: string[]) {
  const nameMap = new Map<string, string[]>();
  for (const file of featureFiles) {
    const name = basename(file);
    const paths = nameMap.get(name) ?? [];
    paths.push(relative(FEATURES_DIR, file));
    nameMap.set(name, paths);
  }

  const duplicates = [...nameMap.entries()].filter(([, paths]) => paths.length > 1);
  if (duplicates.length > 0) {
    console.log(`WARNING: ${duplicates.length} duplicate feature file names:`);
    for (const [name, paths] of duplicates) {
      console.log(`  ${name}:`);
      for (const p of paths) {
        console.log(`    - ${p}`);
      }
    }
    console.log();
  }
}

// ---- Coverage thresholds ----

/**
 * Minimum required coverage percentages per platform.
 *
 * These are RATCHETS, not aspirations: each value is the real measured
 * coverage on 2026-09-11 (see PR fix(test-specs): measure BDD coverage
 * instead of asserting it), rounded down to the nearest integer. They
 * exist so a regression in step-definition coverage fails CI instead of
 * silently passing. This threshold must only ever move UP as real
 * coverage improves — never down, and never back to a value chosen to
 * make a red run go green.
 *
 * Desktop/backend are now measured by real Cucumber-expression matching
 * (see checkPlaywrightBddCoverage); previously this file only checked
 * that `tests/steps/` was non-empty and reported every scenario as
 * covered regardless of content, which is why desktop/backend were
 * fabricated at 100% before this fix.
 *
 * Desktop/backend are 100: since #1153 their projects run with
 * `missingSteps: "fail-on-gen"`, so every scenario their tag filters select
 * must bind or bddgen fails. Scenarios not yet implemented are tagged `@wip`
 * (or `@fixme` when a real defect blocks them) with a linked issue, which
 * removes them from the denominator here exactly as it does in the runner.
 * Anything below 100 means this tool and the runner disagree.
 *
 * iOS is 3.5 — exactly 20/569 (3.51%), measured 2026-09-27 (#1221), so losing
 * a single credited test fails the gate. The previous value, 5, only passed
 * because the matcher was wrong: its 20-character fuzzy fallback added 10
 * scenarios (one of them credited to a test asserting the opposite), and 13 of
 * the 30 it reported lived in a target no CI job ran. The honest number on
 * main before this ratchet was 15/569 (2.6%) — the AuthLoginBDDTests unit
 * tranche alone. The 20 are those 15 plus 5 LlamenosUITests methods, which now
 * count because ci.yml's `ios-e2e` job runs that target under ci-status.
 * iOS reads far below Android because the two are measured differently:
 * Android matches Cucumber step phrases, so one step definition counts toward
 * every scenario that uses it; iOS matches whole scenario titles 1:1 against
 * test method names. Most of the ~520 iOS test methods test real behaviour under
 * their own names. Raising this number means naming (and, where they fall
 * short, extending) tests for the scenarios they actually implement — never
 * renaming a test onto a scenario whose Then-steps it does not assert.
 */
const COVERAGE_THRESHOLDS: Record<Platform, number> = {
  desktop: 100,
  backend: 100,
  android: 76,
  ios: 3.5,
};

// ---- Main ----

function main() {
  console.log("BDD Test Coverage Validation (Multi-Platform)\n");

  const platforms = parsePlatformArg();

  // Parse all features
  const featureFiles = findFiles(FEATURES_DIR, ".feature");
  const allScenarios: Scenario[] = [];
  for (const file of featureFiles) {
    allScenarios.push(...parseFeatureFile(file));
  }

  console.log(
    `Found ${allScenarios.length} total scenarios across ${featureFiles.length} feature files\n`
  );

  // Report per-platform scenario counts
  reportPlatformTagCounts(allScenarios);

  // Warn on features missing platform tags
  reportUntaggedFeatures(featureFiles);

  // Check for duplicate feature basenames
  checkDuplicateFeatureNames(featureFiles);

  // Every deliberate exclusion must name its issue
  const untrackedSkipCount = reportUntrackedSkipTags(featureFiles);

  const results: { platform: string; total: number; covered: number; missing: number }[] = [];

  for (const platform of platforms) {
    const platformScenarios = scenariosForPlatform(allScenarios, platform);
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Platform: ${platform.toUpperCase()} (${platformScenarios.length} scenarios tagged @${platform})`);
    console.log(`${"=".repeat(60)}\n`);

    if (platformScenarios.length === 0) {
      console.log(`  No scenarios tagged @${platform}\n`);
      results.push({ platform, total: 0, covered: 0, missing: 0 });
      continue;
    }

    let result: { covered: number; missing: number };

    switch (platform) {
      case "android":
        result = checkAndroidCoverage(platformScenarios);
        break;
      case "desktop":
        result = checkDesktopCoverage(platformScenarios);
        break;
      case "ios":
        result = checkIosCoverage(platformScenarios);
        break;
      case "backend":
        result = checkBackendCoverage(platformScenarios);
        break;
    }

    results.push({
      platform,
      total: platformScenarios.length,
      covered: result.covered,
      missing: result.missing,
    });
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("Summary");
  console.log(`${"=".repeat(60)}`);

  let failed = false;

  if (untrackedSkipCount > 0) {
    console.log(`  ✗ ${untrackedSkipCount} @wip/@fixme/@skip tag(s) with no linked issue (listed above)`);
    failed = true;
  }

  for (const r of results) {
    const pct = r.total > 0 ? (r.covered / r.total) * 100 : 100;
    const pctStr = r.total > 0 ? pct.toFixed(1) : "N/A";
    const threshold = COVERAGE_THRESHOLDS[r.platform as Platform] ?? 100;
    const belowThreshold = r.total > 0 && pct < threshold;
    const status = belowThreshold ? "✗" : "✓";
    const thresholdNote = threshold < 100 ? ` (threshold: ${threshold}%)` : "";
    console.log(`  ${status} ${r.platform}: ${r.covered}/${r.total} (${pctStr}%)${thresholdNote}`);
    if (belowThreshold) {
      console.log(`      Required: ${threshold}%, Actual: ${pctStr}%`);
      failed = true;
    }
  }

  if (failed) {
    console.log(`\nFAILED: see the ✗ lines above.`);
    process.exit(1);
  } else {
    console.log("\nPASSED: All platforms meet their coverage thresholds.");
    process.exit(0);
  }
}

// ---- Test-only exports (used by validate-coverage.test.ts) ----

export const __testing = {
  extractRawScenarioSteps,
  parsePlaywrightBddStepDefs,
  findMatchingStepDef,
  checkPlaywrightBddCoverage,
  newParameterTypeRegistry,
  checkIosCoverage,
  COVERAGE_THRESHOLDS,
};

if (import.meta.main) {
  main();
}
