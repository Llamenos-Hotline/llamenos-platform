import XCTest

/// XCUITest suite for #1720: the session — not a settings screen — loads the
/// user's hubs.
///
/// The launch harness registers the identity and the hub membership through the
/// real admin API, then `--test-no-active-hub` clears the active hub the harness
/// would otherwise set. From there the app is on its own: if nothing fetches
/// `GET /api/hubs` when the session becomes usable, the active hub stays nil and
/// every hub-scoped action refuses to run. These tests never open Settings →
/// Hubs, the one screen that used to load the list.
final class HubSessionRestoreUITests: BaseUITest {

    override func setUp() {
        super.setUp()
        launchAsVolunteerWithoutActiveHub()
    }

    /// Launch against the live backend as a volunteer of this class's hub, with
    /// NO active hub preselected — session restore must choose one (#1720).
    private func launchAsVolunteerWithoutActiveHub() {
        guard !testHubId.isEmpty else {
            XCTFail("No test hub for \(type(of: self)) — is the backend running at \(testHubURL)?")
            return
        }
        app.launchEnvironment["XCTEST_ADMIN_SECRET"] = TestAdminAPI.seedHex
        app.launchArguments.append(contentsOf: [
            "--reset-keychain",
            "--test-authenticated",
            "--test-volunteer-identity",
            "--test-hub-url", testHubURL,
            "--test-hub-id", testHubId,
            "--test-register",
            "--test-no-active-hub",
        ])
        app.launchToFirstScreen()
        XCTAssertTrue(
            find("main-tab-view").waitForExistence(timeout: 60),
            "The app should reach its main screen after an authenticated launch"
        )
    }

    /// Scenario: "Clock in works without opening hub settings".
    ///
    /// Clock-in names its hub explicitly from the active hub; with the #1720
    /// loader removed the active hub is nil here and the tap answers
    /// "No hub selected", so this test fails — which is the point.
    func testClockInWorksWithoutOpeningHubSettings() {
        given("a volunteer who has never opened the hub management screen") {
            // Launch already registered membership without setting an active hub.
        }
        when("they restore their session and open the shifts tab") {
            navigateToShifts()
        }
        then("they can clock in to their hub") {
            let clockIn = find("clock-in-button")
            XCTAssertTrue(
                clockIn.waitForExistence(timeout: 20),
                "Clock-in button should exist on the shifts tab"
            )
            clockIn.tap()
            XCTAssertTrue(
                find("clock-out-button").waitForExistence(timeout: 20),
                "Clock-in must succeed without visiting Settings → Hubs: the session-restore "
                    + "membership load (#1720) is what selects the volunteer's hub"
            )
        }
    }
}
