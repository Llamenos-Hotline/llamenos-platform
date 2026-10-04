/**
 * Self-tests for the BDD coverage validator.
 *
 * These exist because the previous version of `checkDesktopCoverage` /
 * `checkBackendCoverage` reported 100% coverage as long as
 * `tests/steps/**\/*.ts` was non-empty — it never actually looked at
 * scenario step text vs. registered step definitions. That defect was only
 * caught by manually deleting hundreds of real step files and noticing the
 * reported number didn't move.
 *
 * The tests below assert the validator can actually FAIL: feed it a
 * scenario whose step text has no matching step definition, and it must
 * report that scenario as uncovered. Without a test like this, a future
 * refactor could reintroduce the "always covered" bug and nothing would
 * catch it before it shipped.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __testing, findUntrackedSkipTags, parseFeatureFile, scenariosForPlatform } from "./validate-coverage";

const {
  extractRawScenarioSteps,
  parsePlaywrightBddStepDefs,
  findMatchingStepDef,
  newParameterTypeRegistry,
  checkPlaywrightBddCoverage,
} = __testing;

function withTempFeatureFile(content: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "coverage-validator-test-"));
  const path = join(dir, "temp.feature");
  writeFileSync(path, content, "utf-8");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTempStepFile(content: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "coverage-validator-steps-"));
  const path = join(dir, "temp.steps.ts");
  writeFileSync(path, content, "utf-8");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("findMatchingStepDef (Cucumber Expression matching)", () => {
  test("matches a step with no parameters", () => {
    withTempStepFile(`Given('an empty audit log', async () => {})`, (stepFile) => {
      const registry = newParameterTypeRegistry();
      const defs = parsePlaywrightBddStepDefs(stepFile, registry);
      expect(findMatchingStepDef("an empty audit log", defs)).toBeDefined();
    });
  });

  test("matches {int}/{string} parameter types like the real runner", () => {
    withTempStepFile(
      `Then('the error message contains {string}', async (_f, s: string) => {})\n` +
        `Given('an audit log with {int} entry/entries', async (_f, n: number) => {})`,
      (stepFile) => {
        const registry = newParameterTypeRegistry();
        const defs = parsePlaywrightBddStepDefs(stepFile, registry);
        expect(findMatchingStepDef('the error message contains "boom"', defs)).toBeDefined();
        // "entry/entries" is a Cucumber Expression alternation — matches either word
        expect(findMatchingStepDef("an audit log with 5 entries", defs)).toBeDefined();
        expect(findMatchingStepDef("an audit log with 1 entry", defs)).toBeDefined();
        // {int} must not match non-numeric text
        expect(findMatchingStepDef("an audit log with five entries", defs)).toBeUndefined();
      }
    );
  });

  test("is keyword-agnostic (matchKeywords is not enabled in this repo's playwright.config.ts)", () => {
    withTempStepFile(`Given('I navigate to the {string} page', async () => {})`, (stepFile) => {
      const registry = newParameterTypeRegistry();
      const defs = parsePlaywrightBddStepDefs(stepFile, registry);
      // A "When" step in the feature file must still bind to a "Given"-registered def,
      // exactly like the real audit-log.feature scenarios do.
      expect(findMatchingStepDef('I navigate to the "Audit Log" page', defs)).toBeDefined();
    });
  });

  // THE REGRESSION TEST: this is what the original bug would have failed.
  // A scenario whose step text matches NO registered step definition must
  // be reported as uncovered, not silently counted as covered because
  // *some* .ts file exists in the steps directory.
  test("reports NO match for step text that no step definition covers", () => {
    withTempStepFile(`Given('a completely unrelated step', async () => {})`, (stepFile) => {
      const registry = newParameterTypeRegistry();
      const defs = parsePlaywrightBddStepDefs(stepFile, registry);
      expect(findMatchingStepDef("I do something nobody implemented", defs)).toBeUndefined();
    });
  });
});

describe("extractRawScenarioSteps", () => {
  test("collects Background steps + scenario steps in order", () => {
    const feature = `Feature: Demo
  Background:
    Given I am authenticated as a volunteer

  Scenario: Do the thing
    When I do the thing
    Then it should work
`;
    withTempFeatureFile(feature, (path) => {
      const steps = extractRawScenarioSteps(path, "Do the thing").map((s) => s.text);
      expect(steps).toEqual(["I am authenticated as a volunteer", "I do the thing", "it should work"]);
    });
  });

  // admin/ban-management.feature: a Background inside a Rule used to be applied to
  // every scenario in the file, so scenarios in a *different* Rule were reported
  // unbound (a desktop navigation step) while playwright-bdd bound and ran them.
  test("scopes a Rule's Background to that Rule, and applies the Feature Background everywhere", () => {
    const feature = `Feature: Demo
  Background:
    Given the server is up

  Rule: UI
    Background:
      Given I navigate to the "Ban List" page

    Scenario: UI scenario
      Then I see the list

  Rule: API
    Scenario: API scenario
      When a call arrives
`;
    withTempFeatureFile(feature, (path) => {
      expect(extractRawScenarioSteps(path, "UI scenario").map((s) => s.text)).toEqual([
        "the server is up",
        'I navigate to the "Ban List" page',
        "I see the list",
      ]);
      expect(extractRawScenarioSteps(path, "API scenario").map((s) => s.text)).toEqual([
        "the server is up",
        "a call arrives",
      ]);
    });
  });

  test("substitutes the first Examples row into <placeholder> tokens for Scenario Outline", () => {
    const feature = `Feature: Demo
  Scenario Outline: Answer <count> calls
    Given I have answered <count> calls today
    Then the total should be <count>

    Examples:
      | count |
      | 5     |
      | 12    |
`;
    withTempFeatureFile(feature, (path) => {
      const steps = extractRawScenarioSteps(path, "Answer <count> calls").map((s) => s.text);
      expect(steps).toEqual(["I have answered 5 calls today", "the total should be 5"]);
    });
  });
});

describe("checkPlaywrightBddCoverage (end-to-end validator behavior)", () => {
  test("marks a scenario uncovered when its step has no matching step definition, and covered when it does", () => {
    const featureContent = `@desktop
Feature: Demo Feature

  Scenario: Covered scenario
    Given a completely unrelated step

  Scenario: Uncovered scenario
    Given a step nobody has implemented
`;
    const featuresDir = mkdtempSync(join(tmpdir(), "coverage-validator-features-"));
    const stepsDir = mkdtempSync(join(tmpdir(), "coverage-validator-stepsdir-"));
    try {
      const featurePath = join(featuresDir, "demo.feature");
      writeFileSync(featurePath, featureContent, "utf-8");
      writeFileSync(
        join(stepsDir, "demo.steps.ts"),
        `Given('a completely unrelated step', async () => {})`,
        "utf-8"
      );

      const allScenarios = parseFeatureFile(featurePath, featuresDir);
      const desktopScenarios = scenariosForPlatform(allScenarios, "desktop");
      expect(desktopScenarios).toHaveLength(2);

      const result = checkPlaywrightBddCoverage(desktopScenarios, stepsDir, "desktop-test", featuresDir);

      // THIS is the assertion that would have caught the original bug:
      // the old implementation returned { covered: scenarios.length, missing: 0 }
      // as long as stepsDir contained any .ts file at all.
      expect(result).toEqual({ covered: 1, missing: 1 });
    } finally {
      rmSync(featuresDir, { recursive: true, force: true });
      rmSync(stepsDir, { recursive: true, force: true });
    }
  });

  test("regression guard: an empty-looking step dir with unrelated steps does not fabricate 100% coverage", () => {
    // This directly reproduces the audit's delete-most-of-tests/steps experiment
    // at unit-test scale: a steps directory that exists and has content, but
    // whose content does not implement the scenario under test.
    const featureContent = `@backend
Feature: Regression Demo

  Scenario: Nothing implements this
    Given a scenario step nobody wrote a definition for
`;
    const featuresDir = mkdtempSync(join(tmpdir(), "coverage-validator-features-"));
    const stepsDir = mkdtempSync(join(tmpdir(), "coverage-validator-stepsdir-"));
    try {
      const featurePath = join(featuresDir, "regression.feature");
      writeFileSync(featurePath, featureContent, "utf-8");
      // Non-empty steps dir, but nothing matches the scenario above.
      writeFileSync(join(stepsDir, "unrelated.steps.ts"), `Given('totally different step', async () => {})`, "utf-8");

      const allScenarios = parseFeatureFile(featurePath, featuresDir);
      const backendScenarios = scenariosForPlatform(allScenarios, "backend");

      const result = checkPlaywrightBddCoverage(backendScenarios, stepsDir, "backend-test", featuresDir);

      expect(result.covered).toBe(0);
      expect(result.missing).toBe(1);
    } finally {
      rmSync(featuresDir, { recursive: true, force: true });
      rmSync(stepsDir, { recursive: true, force: true });
    }
  });
});

describe("parseFeatureFile tag handling", () => {
  test("keeps scenario tags across a comment between the tag line and the keyword", () => {
    const feature = `@backend
Feature: Demo

  @fixme
  # Requires a registered Signal number — #1196
  Scenario: Tagged then commented
    Given something
`;
    withTempFeatureFile(feature, (path) => {
      const [s] = parseFeatureFile(path, join(path, ".."));
      expect(s.allTags).toContain("fixme");
      // excluded from backend exactly as the runner's tag filter excludes it
      expect(scenariosForPlatform([s], "backend")).toHaveLength(0);
    });
  });

  test("accumulates tags from several tag lines", () => {
    const feature = `@backend
@security
Feature: Demo

  @smoke
  @wip
  Scenario: Two tag lines
    Given something
`;
    withTempFeatureFile(feature, (path) => {
      const [s] = parseFeatureFile(path, join(path, ".."));
      expect(s.allTags.sort()).toEqual(["backend", "security", "smoke", "wip"]);
    });
  });
});

// #1153: with missingSteps: "fail-on-gen", @wip/@fixme/@skip are the only way to
// keep a scenario out of a run. Each must name its issue, or the tag is just the
// old silent skip with extra steps.
describe("findUntrackedSkipTags", () => {
  function untracked(feature: string) {
    let result: ReturnType<typeof findUntrackedSkipTags> = [];
    withTempFeatureFile(feature, (path) => {
      result = findUntrackedSkipTags(path, join(path, ".."));
    });
    return result;
  }

  test("flags @wip, @fixme and @skip with no issue reference", () => {
    const result = untracked(`@backend
Feature: Demo

  @wip
  Scenario: A
    Given a

  # needs a registered number, no ticket yet
  @fixme
  Scenario: B
    Given b

  @smoke @skip
  Scenario: C
    Given c
`);
    expect(result.map((u) => [u.line, u.tags, u.target])).toEqual([
      [4, ["wip"], "Scenario: A"],
      [9, ["fixme"], "Scenario: B"],
      [13, ["skip"], "Scenario: C"],
    ]);
  });

  test("accepts a #N or /issues/N reference in the annotation block above or below the tag", () => {
    expect(
      untracked(`# @wip: no step definitions — #1122
@backend @wip
Feature: Demo

  # @fixme: API-seeded contacts are undecryptable in the desktop UI —
  # see https://github.com/Llamenos-Hotline/llamenos-platform/issues/796
  @desktop @fixme
  Scenario: Above
    Given a

  @fixme
  # Tracked in #1196.
  Scenario: Below
    Given b
`)
    ).toEqual([]);
  });

  test("does not accept a reference separated from the tag by a blank line", () => {
    const result = untracked(`@backend
Feature: Demo

  # section header that happens to mention #1122

  @wip
  Scenario: Detached
    Given a
`);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe("Scenario: Detached");
  });

  test("does not treat an HTML entity or URL fragment as an issue reference", () => {
    expect(
      untracked(`@backend
Feature: Demo

  # see &#1153; and https://example.com/page#1153
  @wip
  Scenario: Not a reference
    Given a
`)
    ).toHaveLength(1);
  });

  test("ignores a commented-out tag", () => {
    expect(
      untracked(`@backend
Feature: Demo

  # @wip
  Scenario: Runs normally
    Given a
`)
    ).toEqual([]);
  });
});
