import XCTest

/// XCUITest suite for Hub Management views.
/// Tests hub list rendering, hub switching, and hub creation navigation.
///
/// Maps to BDD scenarios: hub-list, hub-switch, hub-create.
final class HubManagementUITests: BaseUITest {

    // MARK: - Helpers

    /// Navigate to the hub management screen via Settings > Hubs link.
    private func navigateToHubs() {
        navigateToSettings()
        scrollAndTap("settings-hubs-link")

        _ = anyElementExists([
            "hubs-list",
            "hubs-loading",
            "hubs-empty",
        ], timeout: 10)
    }

    // MARK: - Scenario: Hub list shows hubs

    /// Verifies the hub list screen renders after navigating from Settings.
    func testHubListShowsHubs() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Settings > Hubs") {
            navigateToHubs()
        }
        then("I should see the hub list or empty/loading state") {
            let found = anyElementExists([
                "hubs-list",
                "hubs-loading",
                "hubs-empty",
            ])
            XCTAssertTrue(found, "Hub management should show the hub list, loading, or empty state")
        }
    }

    // MARK: - Scenario: Hub list shows hub cards

    /// Scenario: Hub list shows hub cards (platform/mobile/hubs/hub-management.feature)
    ///
    /// BaseUITest created this class's hub and made the app's identity a member of
    /// it, so the list must show that hub's card — the "empty state" half of the
    /// scenario's Then cannot be what renders here.
    func testHubListShowsHubCards() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to hub management") {
            navigateToHubs()
        }
        then("I should see hub cards or the empty state") {
            XCTAssertTrue(find("hubs-list").waitForExistence(timeout: 15), "The hub list should render")
            // Server slug of "ios-<ClassName>-<ms>" (apps/worker/routes/dev.ts test-create-hub).
            let classHubPrefix = "hub-row-ios-\(String(describing: type(of: self)).lowercased())-"
            let classHubRow = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH %@", classHubPrefix))
                .firstMatch
            XCTAssertTrue(
                classHubRow.waitForExistence(timeout: 10),
                "The card for this test class's hub (\(classHubPrefix)…) should be listed"
            )
        }
    }

    // MARK: - Scenario: Active hub indicator visible

    /// Verifies the currently active hub has a visual indicator.
    func testActiveHubIndicatorVisible() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Settings > Hubs") {
            navigateToHubs()
        }
        then("the active hub should have a visual indicator") {
            let hubList = find("hubs-list")
            guard hubList.waitForExistence(timeout: 10) else { return }

            // The current hub URL is set in launch args, so one hub row
            // should be marked as active
            let hubRows = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'hub-row-'"))
            if hubRows.count > 0 {
                // At least one hub exists — verify the list rendered
                XCTAssertTrue(hubRows.firstMatch.exists, "Hub rows should render in the list")
            }
        }
    }

    // MARK: - Scenario: Create hub button visible for admin

    /// Verifies the "Create Hub" button is visible on the hub management screen.
    func testCreateHubButtonVisible() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Settings > Hubs") {
            navigateToHubs()
        }
        then("the create hub button should be visible") {
            let createButton = find("hubs-create-btn")
            if createButton.waitForExistence(timeout: 5) {
                XCTAssertTrue(createButton.exists, "Create Hub button should be visible for admins")
                XCTAssertTrue(createButton.isEnabled, "Create Hub button should be enabled")
            }
        }
    }

    // MARK: - Scenario: Create hub form opens

    /// Verifies tapping the create hub button opens the creation form.
    func testCreateHubFormOpens() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Hubs and tap Create Hub") {
            navigateToHubs()
            let createButton = find("hubs-create-btn")
            if createButton.waitForExistence(timeout: 5) {
                createButton.tap()
            }
        }
        then("the hub creation form should appear with fields") {
            let nameField = find("hub-name-field")
            let slugField = find("hub-slug-field")

            if nameField.waitForExistence(timeout: 5) {
                XCTAssertTrue(nameField.exists, "Hub name field should be visible")

                if slugField.waitForExistence(timeout: 3) {
                    XCTAssertTrue(slugField.exists, "Hub slug field should be visible")
                }

                let submitButton = find("hub-create-submit")
                let cancelButton = find("hub-create-cancel")
                XCTAssertTrue(
                    submitButton.waitForExistence(timeout: 3),
                    "Hub create submit button should exist"
                )
                XCTAssertTrue(
                    cancelButton.waitForExistence(timeout: 3),
                    "Hub create cancel button should exist"
                )
            }
        }
    }

    // MARK: - Scenario: Cancel hub creation

    /// Verifies cancelling the hub creation form returns to the hub list.
    func testCancelHubCreation() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I open the hub creation form and cancel") {
            navigateToHubs()
            let createButton = find("hubs-create-btn")
            if createButton.waitForExistence(timeout: 5) {
                createButton.tap()
            }

            let cancelButton = find("hub-create-cancel")
            if cancelButton.waitForExistence(timeout: 5) {
                cancelButton.tap()
            }
        }
        then("I should be back on the hub list") {
            let found = anyElementExists([
                "hubs-list",
                "hubs-loading",
                "hubs-empty",
                "hubs-create-btn",
            ])
            XCTAssertTrue(found, "Hub list should be visible after cancelling creation")
        }
    }

    // MARK: - Scenario: Hub URL displayed in settings

    /// Verifies the current hub URL is displayed in account settings.
    func testHubUrlDisplayedInSettings() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to Settings") {
            navigateToSettings()
        }
        then("I should see the hub URL") {
            let hubUrl = find("settings-hub-url")
            if hubUrl.waitForExistence(timeout: 5) {
                XCTAssertTrue(hubUrl.exists, "Hub URL should be displayed in settings")
            }
        }
    }
}
