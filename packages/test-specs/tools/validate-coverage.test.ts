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

// ---------------------------------------------------------------------------
// Android: tagged → selected → shipped → bound (#1212)
//
// The previous gate credited a scenario for being @android-tagged and having a
// step binding, so 362 scenarios in files `copyFeatureFiles` never ships counted
// as covered. These tests build a miniature repo layout and assert the gate can
// FAIL in each direction, naming the scenario or file responsible.
// ---------------------------------------------------------------------------
import { mkdirSync } from "fs";
import {
  classifyAndroid,
  evaluateAndroidGate,
  matchesTagExpression,
  readAndroidRunnerTags,
  readAndroidShippedDirs,
  stripKotlinComments,
  writeAndroidBaseline,
  type AndroidPaths,
  type Scenario,
} from "./validate-coverage";

const RUNNER = `@CucumberOptions(features = ["features"], glue = ["x"], tags = "@android and not @wip")\nclass R`;
const GRADLE = (from: string) => `
val copyFeatureFiles by tasks.registering(Copy::class) {
    from("\${rootProject.projectDir}/../../packages/test-specs/features/${from}")
    into("src/androidTest/assets/features/${from}")
}

tasks.named("preBuild") { dependsOn(copyFeatureFiles) }
`;
const STEPS = `
class S {
    @Given("the app is open") fun open() {}
    @Then("the home screen shows") fun home() {}
    @Then("the home screen is shown") fun home2() {}
}
`;

function feature(tags: string, scenarios: Record<string, string[]>): string {
  const body = Object.entries(scenarios)
    .map(([title, steps]) => `  Scenario: ${title}\n${steps.map((s) => `    ${s}`).join("\n")}`)
    .join("\n\n");
  return `${tags}\nFeature: F\n\n${body}\n`;
}

function withAndroidRepo(
  files: { shipped?: Record<string, string>; unshipped?: Record<string, string>; steps?: string; shippedDir?: string },
  fn: (paths: AndroidPaths, scenarios: Scenario[]) => void
) {
  const root = mkdtempSync(join(tmpdir(), "android-funnel-"));
  try {
    const shippedDir = files.shippedDir ?? "platform/mobile";
    const featuresDir = join(root, "features");
    const stepsDir = join(root, "steps");
    mkdirSync(stepsDir, { recursive: true });
    writeFileSync(join(stepsDir, "S.kt"), files.steps ?? STEPS);
    writeFileSync(join(root, "Runner.kt"), RUNNER);
    writeFileSync(join(root, "build.gradle.kts"), GRADLE(shippedDir));
    const scenarios: Scenario[] = [];
    for (const [dir, group] of [[shippedDir, files.shipped], ["core", files.unshipped]] as const) {
      for (const [name, content] of Object.entries(group ?? {})) {
        const path = join(featuresDir, dir, name);
        mkdirSync(join(featuresDir, dir), { recursive: true });
        writeFileSync(path, content);
        scenarios.push(...parseFeatureFile(path, featuresDir));
      }
    }
    fn(
      {
        runnerKt: join(root, "Runner.kt"),
        buildGradle: join(root, "build.gradle.kts"),
        stepsDir,
        featuresDir,
        baseline: join(root, "baseline.json"),
      },
      scenarios
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Android execution funnel", () => {
  test("reads the runner's tag expression and the shipped dirs from the real files, not constants", () => {
    withAndroidRepo({}, (paths) => {
      expect(readAndroidRunnerTags(paths.runnerKt)).toBe("@android and not @wip");
      expect(readAndroidShippedDirs(paths.buildGradle)).toEqual(["platform/mobile"]);
    });
    withAndroidRepo({ shippedDir: "platform/mobile/hubs" }, (paths) => {
      expect(readAndroidShippedDirs(paths.buildGradle)).toEqual(["platform/mobile/hubs"]);
    });
  });

  test("tag expressions: and / or / not / parentheses", () => {
    expect(matchesTagExpression("@android and not @wip", ["android"])).toBe(true);
    expect(matchesTagExpression("@android and not @wip", ["android", "wip"])).toBe(false);
    expect(matchesTagExpression("@a and (@b or @c)", ["a", "c"])).toBe(true);
    expect(matchesTagExpression("@a and (@b or @c)", ["a"])).toBe(false);
    expect(matchesTagExpression("not @a or @b", ["b"])).toBe(true);
    expect(() => matchesTagExpression("@a and", ["a"])).toThrow();
  });

  test("a bound scenario in a shipped file executes", () => {
    withAndroidRepo(
      { shipped: { "ok.feature": feature("@android", { Opens: ["Given the app is open", "Then the home screen shows"] }) } },
      (paths, scenarios) => {
        const { funnel } = classifyAndroid(scenarios, paths);
        expect(funnel).toMatchObject({ tagged: 1, selected: 1, shipped: 1, bound: 1, executed: 1 });
      }
    );
  });

  test("a bound scenario in a file the APK does not contain is tagged but NOT executed", () => {
    withAndroidRepo(
      { unshipped: { "dead.feature": feature("@android", { Dead: ["Given the app is open"] }) } },
      (paths, scenarios) => {
        const { funnel, verdicts } = classifyAndroid(scenarios, paths);
        expect(funnel).toMatchObject({ tagged: 1, selected: 1, shipped: 0, executed: 0 });
        expect(verdicts[0].unbound).toEqual([]); // implementation exists; the file just never ships
      }
    );
  });

  test("@wip is deselected by the runner expression and stays out of the total", () => {
    withAndroidRepo(
      { shipped: { "w.feature": feature("@android @wip", { Parked: ["Given a step nobody wrote"] }) } },
      (paths, scenarios) => {
        const { funnel } = classifyAndroid(scenarios, paths);
        expect(funnel).toMatchObject({ tagged: 1, selected: 0, executed: 0 });
        expect(evaluateAndroidGate(classifyAndroid(scenarios, paths).verdicts, paths.baseline).failures).toEqual([]);
      }
    );
  });

  test("BREAK: a shipped @android scenario with no step binding fails the gate and names the scenario and step", () => {
    withAndroidRepo(
      {
        shipped: {
          "ok.feature": feature("@android", { Opens: ["Given the app is open"] }),
          "bad.feature": feature("@android", { "Unbound flow": ["Given the app is open", "Then a step nobody implemented"] }),
        },
      },
      (paths, scenarios) => {
        const { verdicts, funnel } = classifyAndroid(scenarios, paths);
        expect(funnel).toMatchObject({ selected: 2, shipped: 2, executed: 1 });
        const { failures } = evaluateAndroidGate(verdicts, paths.baseline);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain("platform/mobile/bad.feature: Unbound flow");
        expect(failures[0]).toContain("a step nobody implemented");
      }
    );
  });

  test("BREAK: a NEW dead @android tag in an unshipped file fails against the baseline and names the file", () => {
    withAndroidRepo(
      { unshipped: { "old.feature": feature("@android", { Old: ["Given the app is open"] }) } },
      (paths, scenarios) => {
        writeAndroidBaseline(classifyAndroid(scenarios, paths).verdicts, paths.baseline);
        expect(evaluateAndroidGate(classifyAndroid(scenarios, paths).verdicts, paths.baseline).failures).toEqual([]);
      }
    );
    withAndroidRepo(
      {
        unshipped: {
          "old.feature": feature("@android", { Old: ["Given the app is open"] }),
          "new.feature": feature("@android", { "Brand new dead tag": ["Given the app is open"] }),
        },
      },
      (paths, scenarios) => {
        // baseline only knows old.feature
        const only = scenarios.filter((s) => s.featureFile.endsWith("old.feature"));
        writeAndroidBaseline(classifyAndroid(only, paths).verdicts, paths.baseline);
        const { failures } = evaluateAndroidGate(classifyAndroid(scenarios, paths).verdicts, paths.baseline);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain("core/new.feature");
        expect(failures[0]).toContain("Brand new dead tag");
      }
    );
  });

  test("BREAK: removing a real step definition drops the executed count", () => {
    const f = { shipped: { "ok.feature": feature("@android", { Opens: ["Given the app is open", "Then the home screen shows"] }) } };
    let before = 0;
    withAndroidRepo(f, (paths, scenarios) => {
      before = classifyAndroid(scenarios, paths).funnel.executed;
    });
    withAndroidRepo({ ...f, steps: `class S { @Given("the app is open") fun open() {} }` }, (paths, scenarios) => {
      expect(classifyAndroid(scenarios, paths).funnel.executed).toBe(before - 1);
    });
  });

  test("a step matched by two definitions is ambiguous and does not execute", () => {
    withAndroidRepo(
      { shipped: { "amb.feature": feature("@android", { Ambiguous: ["Given the app is open"] }) },
        steps: `class S { @Given("the app is open") fun a() {}\n @When("the app is open") fun b() {} }` },
      (paths, scenarios) => {
        const { verdicts } = classifyAndroid(scenarios, paths);
        expect(verdicts[0].ambiguous).toEqual(["the app is open"]);
        expect(verdicts[0].executed).toBe(false);
      }
    );
  });

  test("a scenario with no steps is not credited", () => {
    withAndroidRepo({ shipped: { "empty.feature": feature("@android", { Hollow: [] }) } }, (paths, scenarios) => {
      expect(classifyAndroid(scenarios, paths).funnel.executed).toBe(0);
    });
  });
});

describe("stripKotlinComments", () => {
  test("a commented-out step definition is not a step definition", () => {
    const src = `class S {\n  // @Given("line comment")\n  /* @When("block") /* nested */ still comment */\n  @Then("real") fun r() {}\n  val u = "http://not-a-comment"\n}`;
    const out = stripKotlinComments(src);
    expect(out).toContain('@Then("real")');
    expect(out).toContain('"http://not-a-comment"');
    expect(out).not.toContain("line comment");
    expect(out).not.toContain("block");
  });

  test("BREAK: commenting out a real step definition unbinds its scenario", () => {
    withAndroidRepo(
      {
        shipped: { "ok.feature": feature("@android", { Opens: ["Given the app is open"] }) },
        steps: `class S {\n // @Given("the app is open")\n fun open() {}\n}`,
      },
      (paths, scenarios) => {
        expect(classifyAndroid(scenarios, paths).funnel.executed).toBe(0);
      }
    );
  });
});
