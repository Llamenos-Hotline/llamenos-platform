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
  __testing,
} from "./audit-silent-steps";

const { hasAssertion, TS_ASSERTION_RE, KOTLIN_ASSERTION_RE } = __testing;

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
