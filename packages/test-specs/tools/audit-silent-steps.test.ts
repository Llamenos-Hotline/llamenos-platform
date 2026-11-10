/**
 * Self-tests for the silent-pass step audit (#709).
 *
 * The regression this guards against: a step definition whose body is
 * empty, comment-only, or (for `Then`) performs no assertion must be
 * FOUND. Without a test like this, a future refactor of the brace/body
 * scanner could silently stop detecting real silent-pass steps and no CI
 * signal would catch it — the exact failure mode `validate-coverage.ts`
 * had before it was fixed to measure real step bodies instead of just
 * checking a directory was non-empty.
 *
 * Also guards the bug this script shipped with during development: the
 * first body-brace scanner found the arrow callback's *parameter*
 * destructuring brace (`{ page }` in `async ({ page }) => { ... }`)
 * instead of the function body, which made every single step in the repo
 * look empty. `findArrowBodyFindsRealBody` below is that regression test.
 */
import { describe, test, expect } from "bun:test";
import {
  findSilentTsSteps,
  findSilentKotlinSteps,
  findSwallowingKotlinSteps,
  findSwallowingTsSteps,
  androidScenariosThroughSwallow,
  __testing,
} from "./audit-silent-steps";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseFeatureFile } from "./validate-coverage";

const { hasAssertion, TS_ASSERTION_RE, KOTLIN_ASSERTION_RE, findSwallow } = __testing;

describe("findSilentTsSteps", () => {
  test("flags an empty Given body", () => {
    const content = `Given('a thing exists', async ({ page }) => {})\n`;
    const findings = findSilentTsSteps("/fake/steps.ts", content);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe("empty-or-comment-only-body");
  });

  test("flags a comment-only Then body", () => {
    const content =
      `Then('the thing should be visible', async ({ page }) => {\n` +
      `  // TODO: assert this once the UI lands\n` +
      `})\n`;
    const findings = findSilentTsSteps("/fake/steps.ts", content);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe("empty-or-comment-only-body");
  });

  test("flags a Then step with real code but no assertion call", () => {
    const content =
      `Then('the thing should be visible', async ({ page }) => {\n` +
      `  await page.locator('.thing').click()\n` +
      `})\n`;
    const findings = findSilentTsSteps("/fake/steps.ts", content);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe("no-assertion-call");
  });

  test("does NOT flag a Given/When step with real code but no assertion call", () => {
    const content =
      `Given('a thing exists', async ({ page }) => {\n` +
      `  await page.goto('/things')\n` +
      `})\n` +
      `When('I click the thing', async ({ page }) => {\n` +
      `  await page.locator('.thing').click()\n` +
      `})\n`;
    const findings = findSilentTsSteps("/fake/steps.ts", content);
    expect(findings).toHaveLength(0);
  });

  test("does NOT flag a Then step that calls expect()", () => {
    const content =
      `Then('the thing should be visible', async ({ page }) => {\n` +
      `  await expect(page.locator('.thing')).toBeVisible()\n` +
      `})\n`;
    const findings = findSilentTsSteps("/fake/steps.ts", content);
    expect(findings).toHaveLength(0);
  });

  // THE REGRESSION TEST: the first version of findBodyOpenBrace matched the
  // destructured `{ page }` parameter as the function body, extracted an
  // empty "body" for every single step in the repo (3115/3121 flagged on
  // first run against real steps/), and never got as far as checking for
  // an assertion call at all.
  test("finds the real arrow-function body, not the destructured parameter braces", () => {
    const content =
      `Then('the thing should be visible', async ({ page, world }) => {\n` +
      `  await expect(page.locator('.thing')).toBeVisible()\n` +
      `})\n`;
    const findings = findSilentTsSteps("/fake/steps.ts", content);
    expect(findings).toHaveLength(0);
  });

  test("ignores braces and quotes inside string/template literals in the body", () => {
    const content =
      `Then('the thing should say {string}', async ({ page }, msg: string) => {\n` +
      `  const expected = \`literal with a { brace } and "Given(" text\`\n` +
      `  await expect(page.locator('.thing')).toHaveText(expected)\n` +
      `})\n`;
    const findings = findSilentTsSteps("/fake/steps.ts", content);
    expect(findings).toHaveLength(0);
  });

  test("reports the correct line and pattern", () => {
    const content =
      `Given('step one', async ({ page }) => {\n  await page.goto('/')\n})\n\n` +
      `Then('step two', async ({ page }) => {})\n`;
    const findings = findSilentTsSteps("/fake/dir/steps.ts", content);
    expect(findings).toHaveLength(1);
    expect(findings[0].file.endsWith("fake/dir/steps.ts")).toBe(true);
    expect(findings[0].line).toBe(5);
    expect(findings[0].pattern).toBe("step two");
  });
});

describe("findSilentKotlinSteps", () => {
  test("flags an empty @Given body", () => {
    const content =
      `class Steps {\n` +
      `    @Given("a thing exists")\n` +
      `    fun aThingExists() {\n` +
      `        // Precondition handled server-side\n` +
      `    }\n` +
      `}\n`;
    const findings = findSilentKotlinSteps("/fake/Steps.kt", content);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe("empty-or-comment-only-body");
  });

  test("flags a @Then with no assertion call", () => {
    const content =
      `class Steps {\n` +
      `    @Then("the thing should be visible")\n` +
      `    fun theThingShouldBeVisible() {\n` +
      `        onNodeWithTag("thing").performClick()\n` +
      `    }\n` +
      `}\n`;
    const findings = findSilentKotlinSteps("/fake/Steps.kt", content);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe("no-assertion-call");
  });

  test("does NOT flag a @When with real code but no assertion call", () => {
    const content =
      `class Steps {\n` +
      `    @When("I click the thing")\n` +
      `    fun iClickTheThing() {\n` +
      `        onNodeWithTag("thing").performClick()\n` +
      `    }\n` +
      `}\n`;
    const findings = findSilentKotlinSteps("/fake/Steps.kt", content);
    expect(findings).toHaveLength(0);
  });

  test("does NOT flag a @Then that calls assertIsDisplayed()", () => {
    const content =
      `class Steps {\n` +
      `    @Then("the thing should be visible")\n` +
      `    fun theThingShouldBeVisible() {\n` +
      `        onNodeWithTag("thing").assertIsDisplayed()\n` +
      `    }\n` +
      `}\n`;
    const findings = findSilentKotlinSteps("/fake/Steps.kt", content);
    expect(findings).toHaveLength(0);
  });

  test("handles `fun foo() = runBlocking { ... }` bodies", () => {
    const content =
      `class Steps {\n` +
      `    @Then("the key is decrypted")\n` +
      `    fun theKeyIsDecrypted() = runBlocking {\n` +
      `        assertTrue(result.isSuccess)\n` +
      `    }\n` +
      `}\n`;
    const findings = findSilentKotlinSteps("/fake/Steps.kt", content);
    expect(findings).toHaveLength(0);
  });
});

describe("hasAssertion", () => {
  test("empty body wins over the assertion-call check regardless of requireAssertionCall", () => {
    expect(hasAssertion("", TS_ASSERTION_RE, true)).toBe("empty-or-comment-only-body");
    expect(hasAssertion("   \n  ", TS_ASSERTION_RE, false)).toBe("empty-or-comment-only-body");
  });

  test("requireAssertionCall=false never reports no-assertion-call", () => {
    expect(hasAssertion("await page.click('.x')", TS_ASSERTION_RE, false)).toBeNull();
  });

  test("requireAssertionCall=true reports no-assertion-call for action-only bodies", () => {
    expect(hasAssertion("await page.click('.x')", TS_ASSERTION_RE, true)).toBe("no-assertion-call");
  });

  test("KOTLIN_ASSERTION_RE matches assertThat/assertEquals/Assert.* and Espresso check()", () => {
    expect(hasAssertion("assertThat(x).isTrue()", KOTLIN_ASSERTION_RE, true)).toBeNull();
    expect(hasAssertion("Assert.assertEquals(1, 2)", KOTLIN_ASSERTION_RE, true)).toBeNull();
    expect(hasAssertion("onView(withId(R.id.x)).check(matches(isDisplayed()))", KOTLIN_ASSERTION_RE, true)).toBeNull();
    expect(hasAssertion("onNodeWithTag(\"x\").performClick()", KOTLIN_ASSERTION_RE, true)).toBe(
      "no-assertion-call"
    );
  });
});

// #2675: KeyImportSteps.theErrorShouldDisappear wrapped its assertion in
// `try { … } catch (_: Throwable) { }`. It contains an `assert…(` call, so the
// silent-pass audit above passed it, while the step could not fail.
describe("findSwallowingKotlinSteps", () => {
  const step = (keyword: string, body: string) =>
    `class Steps {\n    @${keyword}("the error should disappear")\n    fun theErrorShouldDisappear() {\n${body}\n    }\n}\n`;

  test("flags the exact shape of KeyImportSteps.theErrorShouldDisappear", () => {
    const content = step(
      "Then",
      `        composeRule.waitForIdle()\n` +
        `        try {\n` +
        `            onNodeWithTag("device-key-error").assertDoesNotExist()\n` +
        `        } catch (_: Throwable) {\n` +
        `            // Error state unclear\n` +
        `        }`
    );
    // The silent-pass audit does NOT see it — that is the gap.
    expect(findSilentKotlinSteps("/fake/Steps.kt", content)).toHaveLength(0);
    const findings = findSwallowingKotlinSteps("/fake/Steps.kt", content);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ keyword: "Then", how: "catch-without-rethrow", platform: "android" });
  });

  test("flags a swallowing When as well: the skipped action is why the assertion after it means nothing", () => {
    const findings = findSwallowingKotlinSteps(
      "/fake/Steps.kt",
      step("When", `        try { onNodeWithTag("x").performTextInput("n") } catch (_: Throwable) { }`)
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].keyword).toBe("When");
  });

  test("a narrow exception type is still a swallow", () => {
    const findings = findSwallowingKotlinSteps(
      "/fake/Steps.kt",
      step("Then", `        try { onNodeWithTag("x").assertIsDisplayed() } catch (e: AssertionError) { println(e) }`)
    );
    expect(findings).toHaveLength(1);
  });

  test("does NOT flag a catch that rethrows or fails", () => {
    expect(
      findSwallowingKotlinSteps(
        "/fake/Steps.kt",
        step("Then", `        try { onNodeWithTag("x").assertIsDisplayed() } catch (e: Throwable) { throw AssertionError("x missing", e) }`)
      )
    ).toHaveLength(0);
    expect(
      findSwallowingKotlinSteps(
        "/fake/Steps.kt",
        step("Then", `        try { onNodeWithTag("x").assertIsDisplayed() } catch (e: Throwable) { fail("x missing") }`)
      )
    ).toHaveLength(0);
  });

  test("does NOT flag a step with no catch", () => {
    expect(
      findSwallowingKotlinSteps("/fake/Steps.kt", step("Then", `        onNodeWithTag("x").assertIsDisplayed()`))
    ).toHaveLength(0);
  });

  test("ignores a catch that only appears in a comment", () => {
    expect(
      findSwallowingKotlinSteps(
        "/fake/Steps.kt",
        step("Then", `        // was: try { } catch (_: Throwable) { }\n        onNodeWithTag("x").assertIsDisplayed()`)
      )
    ).toHaveLength(0);
  });

  test("flags runCatching unless the result is unwrapped with getOrThrow", () => {
    expect(
      findSwallowingKotlinSteps("/fake/Steps.kt", step("Then", `        runCatching { onNodeWithTag("x").assertIsDisplayed() }`))[0]
        ?.how
    ).toBe("runCatching-without-getOrThrow");
    expect(
      findSwallowingKotlinSteps(
        "/fake/Steps.kt",
        step("Then", `        runCatching { onNodeWithTag("x").assertIsDisplayed() }.getOrThrow()`)
      )
    ).toHaveLength(0);
  });
});

describe("findSwallowingTsSteps", () => {
  test("flags try/catch with an empty catch", () => {
    const content =
      `Then('the toast shows', async ({ page }) => {\n` +
      `  try { await expect(page.getByTestId('toast')).toBeVisible() } catch {}\n` +
      `})\n`;
    expect(findSwallowingTsSteps("/fake/steps.ts", content)).toHaveLength(1);
  });

  test("flags a promise .catch that returns a value", () => {
    const content =
      `Then('the toast shows', async ({ page }) => {\n` +
      `  const ok = await expect(page.getByTestId('toast')).toBeVisible().catch(() => false)\n` +
      `})\n`;
    expect(findSwallowingTsSteps("/fake/steps.ts", content)[0]?.how).toBe("promise-catch-swallow");
  });

  test("does NOT flag a catch that rethrows", () => {
    const content =
      `Then('the toast shows', async ({ page }) => {\n` +
      `  try { await expect(page.getByTestId('toast')).toBeVisible() } catch (e) { throw new Error('no toast: ' + e) }\n` +
      `})\n`;
    expect(findSwallowingTsSteps("/fake/steps.ts", content)).toHaveLength(0);
  });
});

describe("findSwallow", () => {
  test("returns null for a body with no failure handling", () => {
    expect(findSwallow("await page.click('.x')", "ts")).toBeNull();
    expect(findSwallow('onNodeWithTag("x").performClick()', "kotlin")).toBeNull();
  });
});

describe("androidScenariosThroughSwallow", () => {
  test("lists only scenarios that run on a device and bind to a swallowing step of the requested keyword", () => {
    const dir = mkdtempSync(join(tmpdir(), "swallow-"));
    const features = join(dir, "features");
    mkdirSync(join(features, "platform/mobile"), { recursive: true });
    mkdirSync(join(features, "core"), { recursive: true });
    mkdirSync(join(dir, "steps"), { recursive: true });
    const feature = (title: string) =>
      `Feature: F\n  @android\n  Scenario: ${title}\n    Given the screen is open\n    Then the error should disappear\n`;
    writeFileSync(join(features, "platform/mobile/f.feature"), feature("Runs and swallows"));
    // Same step text under core/, which copyFeatureFiles does not ship: never reaches a device.
    writeFileSync(join(features, "core/g.feature"), feature("Never runs"));
    writeFileSync(
      join(dir, "steps/S.kt"),
      `class S {\n  @Given("the screen is open")\n  fun a() {}\n  @Then("the error should disappear")\n  fun b() {}\n}\n`
    );
    writeFileSync(join(dir, "Runner.kt"), `@CucumberOptions(tags = "@android")\nclass Runner\n`);
    writeFileSync(
      join(dir, "build.gradle.kts"),
      `val copyFeatureFiles by tasks.registering(Copy::class) {\n    from("$rootDir/packages/test-specs/features/platform/mobile")\n}\n`
    );
    const paths = {
      runnerKt: join(dir, "Runner.kt"),
      buildGradle: join(dir, "build.gradle.kts"),
      stepsDir: join(dir, "steps"),
      featuresDir: features,
      baseline: join(dir, "baseline.json"),
    };
    const scenarios = [
      ...parseFeatureFile(join(features, "platform/mobile/f.feature"), features),
      ...parseFeatureFile(join(features, "core/g.feature"), features),
    ];
    const swallow = (keyword: string, pattern: string) => ({
      platform: "android" as const,
      file: "S.kt",
      line: 1,
      keyword,
      pattern,
      how: "catch-without-rethrow" as const,
    });
    const swallowing = [swallow("Then", "the error should disappear"), swallow("Given", "the screen is open")];

    const thenOnly = androidScenariosThroughSwallow(scenarios, swallowing, true, paths);
    expect(thenOnly.map((h) => h.scenario.title)).toEqual(["Runs and swallows"]);
    expect(thenOnly[0].step).toBe("the error should disappear");

    // A swallowing Given alone does not count when only Then is asked for.
    const givenOnly = androidScenariosThroughSwallow(scenarios, [swallow("Given", "the screen is open")], true, paths);
    expect(givenOnly).toHaveLength(0);
    const anyKeyword = androidScenariosThroughSwallow(scenarios, [swallow("Given", "the screen is open")], false, paths);
    expect(anyKeyword.map((h) => h.scenario.title)).toEqual(["Runs and swallows"]);
  });
});
