/**
 * Self-tests for the iOS half of the BDD coverage validator.
 *
 * The iOS matcher used to fall back to a 20-character substring match against
 * any Swift test method, and counted methods in a test target no CI job ran.
 * It reported 30/569 while CI executed 15 (#1221). Every test below feeds the
 * validator a case the old matcher credited and asserts it now refuses it —
 * a validator that cannot fail is not a gate.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { __testing, iosTargetsGatedByCi, type Scenario } from "./validate-coverage";

const { checkIosCoverage } = __testing;

const PROJECT_YML = `
name: Llamenos
targets:
  Llamenos:
    type: application
    sources:
      - path: Sources
    scheme:
      testTargets:
        - LlamenosTests
        - LlamenosUITests
  LlamenosTests:
    type: bundle.unit-test
    sources:
      - path: Tests/Unit
  LlamenosUITests:
    type: bundle.ui-testing
    sources:
      - path: Tests/UI
`;

const CI_YML = `
jobs:
  changes:
    runs-on: ubuntu-latest
  ios-build-test:
    steps:
      - run: |
          xcodebuild test -scheme Llamenos \\
            -only-testing:LlamenosTests \\
            -skip-testing:LlamenosUITests
  ios-e2e:
    uses: ./.github/workflows/ios-e2e.yml
  ci-status:
    needs: [changes, ios-build-test, ios-e2e]
`;

const IOS_E2E_YML = `
jobs:
  ui:
    steps:
      - run: python3 apps/ios/scripts/ui-tests.py shard --index 0 --total 4 > args
`;

const BASE_UI_TEST = `
import XCTest
class BaseUITest: XCTestCase {
    var app: XCUIApplication!
}
`;

function scenario(title: string, featureFile = "core/example.feature"): Scenario {
  return {
    title,
    featureFile,
    featureName: "Example",
    featureTags: ["ios"],
    scenarioTags: [],
    allTags: ["ios"],
    isOutline: false,
  };
}

describe("checkIosCoverage", () => {
  let root: string;
  let paths: { iosRoot: string; projectYml: string; workflowsDir: string };

  const write = (rel: string, content: string) => {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ios-coverage-"));
    paths = {
      iosRoot: join(root, "apps/ios"),
      projectYml: join(root, "apps/ios/project.yml"),
      workflowsDir: join(root, ".github/workflows"),
    };
    write("apps/ios/project.yml", PROJECT_YML);
    write(".github/workflows/ci.yml", CI_YML);
    write(".github/workflows/ios-e2e.yml", IOS_E2E_YML);
    write("apps/ios/Tests/UI/Helpers/BaseUITest.swift", BASE_UI_TEST);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("credits an exactly-named test in a CI-gated target, through BaseUITest", () => {
    write(
      "apps/ios/Tests/UI/HubUITests.swift",
      `final class HubUITests: BaseUITest {\n    func testSwitchActiveHub() { XCTAssertTrue(app.exists) }\n}\n`
    );
    expect(checkIosCoverage([scenario("Switch active hub")], paths)).toEqual({ covered: 1, missing: 0 });
  });

  test("does not credit a merely similar name (the removed fuzzy fallback)", () => {
    // The real case from #1221: this test asserts the active hub is NOT switched.
    write(
      "apps/ios/Tests/Unit/PushRoutingTests.swift",
      `final class PushRoutingTests: XCTestCase {\n    func testBackgroundPushForHubBDoesNotSwitchActiveHubFromHubA() { XCTAssertTrue(app.exists) }\n}\n`
    );
    expect(checkIosCoverage([scenario("Switch active hub")], paths)).toEqual({ covered: 0, missing: 1 });
  });

  test("does not credit one method twice for a scenario whose title merely extends it", () => {
    write(
      "apps/ios/Tests/Unit/AuthLoginBDDTests.swift",
      `final class AuthLoginBDDTests: XCTestCase {\n    func testWrongPinShowsErrorOnUnlock() { XCTAssertTrue(app.exists) }\n}\n`
    );
    const result = checkIosCoverage(
      [scenario("Wrong PIN shows error on unlock"), scenario("Wrong PIN shows error")],
      paths
    );
    expect(result).toEqual({ covered: 1, missing: 1 });
  });

  test("does not credit a target the Llamenos scheme does not test (#168)", () => {
    write("apps/ios/project.yml", PROJECT_YML.replace("        - LlamenosUITests\n", ""));
    write(
      "apps/ios/Tests/UI/HubUITests.swift",
      `final class HubUITests: BaseUITest {\n    func testSwitchActiveHub() { XCTAssertTrue(app.exists) }\n}\n`
    );
    expect(checkIosCoverage([scenario("Switch active hub")], paths)).toEqual({ covered: 0, missing: 1 });
  });

  test("does not credit a target whose CI job is outside ci-status's needs", () => {
    write(".github/workflows/ci.yml", CI_YML.replace("needs: [changes, ios-build-test, ios-e2e]", "needs: [changes, ios-build-test]"));
    write(
      "apps/ios/Tests/UI/HubUITests.swift",
      `final class HubUITests: BaseUITest {\n    func testSwitchActiveHub() { XCTAssertTrue(app.exists) }\n}\n`
    );
    expect(checkIosCoverage([scenario("Switch active hub")], paths)).toEqual({ covered: 0, missing: 1 });
  });

  test("does not credit a target CI only runs from a dispatch-only workflow", () => {
    // What #682 did: the UI workflow existed, but nothing merge-gating called it.
    write(".github/workflows/ci.yml", CI_YML.replace("  ios-e2e:\n    uses: ./.github/workflows/ios-e2e.yml\n", ""));
    write(
      "apps/ios/Tests/UI/HubUITests.swift",
      `final class HubUITests: BaseUITest {\n    func testSwitchActiveHub() { XCTAssertTrue(app.exists) }\n}\n`
    );
    expect(checkIosCoverage([scenario("Switch active hub")], paths)).toEqual({ covered: 0, missing: 1 });
  });

  test("does not credit tests XCTest would not run", () => {
    write(
      "apps/ios/Tests/Unit/NotRunTests.swift",
      [
        "final class NotRunTests: XCTestCase {",
        "    private func testPrivateScenario() { XCTAssertTrue(ok) }",
        "    func testParameterScenario(_ x: Int) { XCTAssertTrue(ok) }",
        "    func testSkippedScenario() throws {",
        '        throw XCTSkip("later")',
        "    }",
        "    // func testCommentedScenario() {}",
        "}",
        "final class Helper {",
        "    func testHelperScenario() { XCTAssertTrue(ok) }",
        "}",
        "",
      ].join("\n")
    );
    const result = checkIosCoverage(
      ["Private scenario", "Parameter scenario", "Skipped scenario", "Commented scenario", "Helper scenario"].map((t) =>
        scenario(t)
      ),
      paths
    );
    expect(result).toEqual({ covered: 0, missing: 5 });
  });

  test("does not credit a test that cannot fail", () => {
    write(
      "apps/ios/Tests/UI/HollowUITests.swift",
      [
        "final class HollowUITests: BaseUITest {",
        "    func testNoAssertionScenario() {",
        "        app.launch()",
        "    }",
        "    func testGracefulPassScenario() {",
        '        if !find("x").exists { XCTAssertTrue(true, "not enabled on this server") }',
        "    }",
        "}",
        "",
      ].join("\n")
    );
    const result = checkIosCoverage([scenario("No assertion scenario"), scenario("Graceful pass scenario")], paths);
    expect(result).toEqual({ covered: 0, missing: 2 });
  });

  test("does not credit a quarantined test — the merge gate skips it", () => {
    write(
      "apps/ios/Tests/UI/HubUITests.swift",
      `final class HubUITests: BaseUITest {\n    func testSwitchActiveHub() { XCTAssertTrue(app.exists) }\n}\n`
    );
    write("apps/ios/Tests/UI/ci-quarantine.txt", "# header\nHubUITests/testSwitchActiveHub  # fails on a filed defect — #1\n");
    expect(checkIosCoverage([scenario("Switch active hub")], paths)).toEqual({ covered: 0, missing: 1 });
  });

  test("a throwing test that tries is asserting", () => {
    write(
      "apps/ios/Tests/Unit/ThrowingTests.swift",
      `final class ThrowingTests: XCTestCase {\n    func testConfiguresHttps() throws {\n        try api.configure(hubURLString: "https://x")\n    }\n}\n`
    );
    expect(checkIosCoverage([scenario("Configures HTTPS")], paths)).toEqual({ covered: 1, missing: 0 });
  });

  test("credits a Swift Testing @Test function", () => {
    write(
      "apps/ios/Tests/Unit/SwiftTestingTests.swift",
      `struct SwiftTestingTests {\n    @Test func testDecryptsPayload() {\n        #expect(decrypt() == "x")\n    }\n}\n`
    );
    expect(checkIosCoverage([scenario("Decrypts payload")], paths)).toEqual({ covered: 1, missing: 0 });
  });

  test("a method nested after a helper type still belongs to its test class", () => {
    write(
      "apps/ios/Tests/Unit/NestedTests.swift",
      [
        "final class NestedTests: XCTestCase {",
        "    private struct Fixture {",
        '        let json = "{\\"a\\": 1}"',
        "    }",
        "    func testNestedScenario() { XCTAssertEqual(1, 1) }",
        "}",
        "",
      ].join("\n")
    );
    expect(checkIosCoverage([scenario("Nested scenario")], paths)).toEqual({ covered: 1, missing: 0 });
  });

  test("two scenarios with one title cannot share one test", () => {
    write(
      "apps/ios/Tests/Unit/QrTests.swift",
      `final class QrTests: XCTestCase {\n    func testQrCodeWithLocalhostRelayShowsError() { XCTAssertTrue(app.exists) }\n}\n`
    );
    const result = checkIosCoverage(
      [
        scenario("QR code with localhost relay shows error", "security/network-security.feature"),
        scenario("QR code with localhost relay shows error", "admin/settings.feature"),
      ],
      paths
    );
    expect(result).toEqual({ covered: 0, missing: 2 });
  });
});

describe("iosTargetsGatedByCi", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ios-gate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a class-level -only-testing selection does not gate the whole target", () => {
    writeFileSync(
      join(dir, "ci.yml"),
      `jobs:\n  ios:\n    steps:\n      - run: xcodebuild test -only-testing:LlamenosUITests/HubUITests\n  ci-status:\n    needs: [ios]\n`
    );
    expect([...iosTargetsGatedByCi(dir).keys()]).toEqual([]);
  });

  test("reads the real workflows: both iOS targets are gated", () => {
    const gated = iosTargetsGatedByCi(join(import.meta.dir, "../../../.github/workflows"));
    expect(gated.has("LlamenosTests")).toBe(true);
    expect(gated.has("LlamenosUITests")).toBe(true);
  });
});
