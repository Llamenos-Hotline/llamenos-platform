import XCTest

/// BDD tests for the Message Blasts feature (Epic 245).
/// Tests the blasts list, creation flow, scheduling, and admin-only visibility.
final class BlastsUITests: BaseUITest {

    // MARK: - Helper: Navigate to Blasts

    /// Navigate to the blasts screen via the Dashboard quick action card (admin only).
    private func navigateToBlasts() {
        let blastsAction = find("dashboard-blasts-action")
        XCTAssertTrue(
            blastsAction.waitForExistence(timeout: 10),
            "Dashboard blasts quick action should exist for admin"
        )
        blastsAction.tap()
        XCTAssertTrue(
            app.navigationBars["Message Blasts"].waitForExistence(timeout: 10),
            "Tapping the blasts card should open Message Blasts"
        )
    }

    /// Launch as admin on a hub of its own, so the blasts screen starts empty and no other
    /// test's blasts are in it.
    private func launchOnFreshHub() -> String {
        launchAsAdminOnFreshHub(named: "ios-blasts") ?? ""
    }

    /// Open the create sheet from the toolbar button, which is there whether or not any blast
    /// exists.
    private func openCreateSheet() {
        scrollAndTap("dashboard-blasts-action")
        let create = find("create-blast-button")
        XCTAssertTrue(create.waitForExistence(timeout: 15), "The toolbar should offer to create a blast")
        create.tap()
        XCTAssertTrue(find("blast-name-input").waitForExistence(timeout: 5), "The create sheet should open")
    }

    // MARK: - Scenario: Blasts quick action visible for admin

    func testBlastsQuickActionVisibleForAdmin() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        then("the dashboard should show a blasts quick action") {
            // Scroll down to find blasts action (it's below reports and contacts)
            let blastsAction = scrollToFind("dashboard-blasts-action")
            XCTAssertTrue(
                blastsAction.exists,
                "Dashboard should have a blasts quick action card for admin"
            )
        }
    }

    // MARK: - Scenario: Blasts quick action hidden for volunteer

    func testBlastsQuickActionHiddenForVolunteer() {
        given("I am authenticated as a volunteer") {
            launchAuthenticated()
        }
        then("the dashboard is up and does not show a blasts quick action") {
            XCTAssertTrue(find("dashboard-title").waitForExistence(timeout: 15), "The dashboard should have loaded")
            XCTAssertTrue(
                find("dashboard-reports-action").waitForExistence(timeout: 10) || scrollToFind("dashboard-reports-action").exists,
                "The quick actions section should have rendered"
            )
            let blastsAction = scrollToFind("dashboard-blasts-action", maxSwipes: 3, timeout: 1)
            XCTAssertFalse(
                blastsAction.exists,
                "Dashboard should not have blasts quick action for volunteer"
            )
        }
    }

    // MARK: - Scenario: Blasts list shows content or empty state

    /// A hub with no blasts shows the empty state — not a list, a spinner or an error.
    func testBlastsListShowsContent() {
        given("I am authenticated as admin on a hub with no blasts") {
            _ = launchOnFreshHub()
        }
        when("I navigate to blasts") {
            scrollAndTap("dashboard-blasts-action")
        }
        then("I should see the empty state") {
            XCTAssertTrue(
                find("blasts-empty-state").waitForExistence(timeout: 20),
                "A hub with no blasts should show the empty state"
            )
            XCTAssertFalse(find("blasts-list").exists)
            XCTAssertFalse(find("blasts-error").exists)
            XCTAssertFalse(find("blasts-loading").exists)
        }
    }

    // MARK: - Scenario: Create blast button opens the sheet

    func testCreateBlastButtonExists() {
        given("I am authenticated as admin on a hub with no blasts") {
            _ = launchOnFreshHub()
        }
        when("I tap the create button in the toolbar") {
            openCreateSheet()
        }
        then("a blast cannot be sent without a name and a message") {
            XCTAssertFalse(
                find("blast-send-button").isEnabled,
                "Send Now must stay off until the blast has a name, a message and a channel"
            )
        }
    }

    // MARK: - Scenario: Create blast sheet opens with all elements

    func testCreateBlastSheetOpens() {
        given("I am authenticated as admin on a hub with no blasts") {
            _ = launchOnFreshHub()
        }
        when("I open the create sheet") {
            openCreateSheet()
        }
        then("each channel is a toggle and Send Now needs content") {
            for (channel, identifier) in [
                ("sms", "blast-channel-sms"), ("whatsapp", "blast-channel-whatsapp"), ("signal", "blast-channel-signal"),
            ] {
                let toggle = find(identifier)
                XCTAssertTrue(toggle.exists, "\(channel) channel toggle should exist")
                XCTAssertNotNil(toggle.value as? String, "\(channel) should be a toggle with an on/off value")
            }
            XCTAssertEqual(find("blast-channel-sms").value as? String, "1", "SMS is the default channel")
            XCTAssertEqual(find("blast-channel-whatsapp").value as? String, "0")
            XCTAssertEqual(find("blast-channel-signal").value as? String, "0")
            XCTAssertFalse(find("blast-send-button").isEnabled, "Send Now should be off while the form is empty")

            let name = find("blast-name-input")
            typeText("Evening update", into: name)
            XCTAssertFalse(find("blast-send-button").isEnabled, "A name alone is not a blast")
            let message = find("blast-message-input")
            typeText("Rally moved to 6pm", into: message)
            XCTAssertTrue(find("blast-send-button").isEnabled, "A name, a message and a channel make a sendable blast")

            find("blast-channel-sms").switches.firstMatch.tap()
            XCTAssertFalse(find("blast-send-button").isEnabled, "A blast with no channel cannot be sent")
        }
    }

    // MARK: - Scenario: Schedule button toggles date picker

    func testScheduleButtonTogglesDatePicker() {
        given("I am authenticated as admin with the create sheet open") {
            _ = launchOnFreshHub()
            openCreateSheet()
            XCTAssertFalse(find("blast-schedule-picker").exists, "The schedule picker is hidden until asked for")
        }
        when("I tap Schedule for Later") {
            find("blast-schedule-button").tap()
        }
        then("the date picker and Confirm Schedule appear, and tapping again hides them") {
            XCTAssertTrue(find("blast-schedule-picker").waitForExistence(timeout: 5), "The schedule date picker should appear")
            XCTAssertTrue(find("blast-confirm-schedule").exists, "Confirm schedule button should appear")

            find("blast-schedule-button").tap()
            XCTAssertTrue(
                find("blast-schedule-picker").waitForNonExistence(timeout: 5),
                "Hide Schedule should remove the date picker"
            )
            XCTAssertFalse(find("blast-confirm-schedule").exists)
        }
    }

    // MARK: - Scenario: Cancel blast creation

    func testCancelBlastCreation() {
        var hubId = ""
        let name = "Cancelled \(UUID().uuidString.prefix(8))"
        given("I am authenticated as admin with the create sheet open and a name typed") {
            hubId = launchOnFreshHub()
            openCreateSheet()
            let input = find("blast-name-input")
            typeText(name, into: input)
        }
        when("I cancel") {
            app.buttons["cancel-blast-create"].tap()
        }
        then("the sheet is gone and no blast was created") {
            XCTAssertTrue(find("blast-name-input").waitForNonExistence(timeout: 10), "Cancel should close the sheet")
            let data = TestAdminAPI.send("GET", "/api/hubs/\(hubId)/blasts", baseURL: testHubURL)
            let text = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
            XCTAssertFalse(text.contains(name), "A cancelled blast must not reach the server: \(text)")
        }
    }

    // MARK: - Scenario: Empty state shows create button

    /// A hub with no blasts offers to create the first one, and the button opens the sheet.
    func testEmptyStateShowsCreateButton() {
        given("I am authenticated as admin on a hub with no blasts") {
            _ = launchOnFreshHub()
        }
        when("I open blasts and tap the empty state's button") {
            scrollAndTap("dashboard-blasts-action")
            let createFirst = find("create-first-blast")
            XCTAssertTrue(createFirst.waitForExistence(timeout: 20), "The empty state should offer to create the first blast")
            createFirst.tap()
        }
        then("the create sheet opens") {
            XCTAssertTrue(find("blast-name-input").waitForExistence(timeout: 5), "Create First Blast should open the sheet")
        }
    }
}
