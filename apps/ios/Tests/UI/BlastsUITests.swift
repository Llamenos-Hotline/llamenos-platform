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

        _ = anyElementExists([
            "blasts-list", "blasts-empty-state", "blasts-loading", "blasts-error",
        ])
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
        then("the dashboard should not show a blasts quick action") {
            let blastsAction = find("dashboard-blasts-action")
            XCTAssertFalse(
                blastsAction.waitForExistence(timeout: 3),
                "Dashboard should not have blasts quick action for volunteer"
            )
        }
    }

    // MARK: - Scenario: Blasts list shows content or empty state

    func testBlastsListShowsContent() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to blasts") {
            // Scroll to find the blasts action first
            scrollAndTap("dashboard-blasts-action")
            _ = anyElementExists([
                "blasts-list", "blasts-empty-state", "blasts-loading", "blasts-error",
            ])
        }
        then("I should see the blasts list or empty state") {
            let found = anyElementExists([
                "blasts-list", "blasts-empty-state", "blasts-loading", "blasts-error",
            ])
            XCTAssertTrue(found, "Blasts view should show list, empty state, loading, or error")
        }
    }

    // MARK: - Scenario: Create blast button exists

    func testCreateBlastButtonExists() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to blasts") {
            scrollAndTap("dashboard-blasts-action")
            _ = anyElementExists([
                "blasts-list", "blasts-empty-state", "blasts-loading",
            ])
        }
        then("I should see the create blast button") {
            let found = anyElementExists(["create-blast-button", "create-first-blast"], timeout: 5)
            XCTAssertTrue(found, "Create blast button should exist in toolbar or empty state")
        }
    }

    // MARK: - Scenario: Create blast sheet opens with all elements

    func testCreateBlastSheetOpens() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to blasts and tap create") {
            scrollAndTap("dashboard-blasts-action")
            _ = anyElementExists(["blasts-list", "blasts-empty-state", "blasts-loading"])

            // Try toolbar button first, then empty state button
            let createButton = find("create-blast-button")
            if createButton.waitForExistence(timeout: 3) {
                createButton.tap()
            } else {
                let createFirst = find("create-first-blast")
                if createFirst.waitForExistence(timeout: 3) {
                    createFirst.tap()
                }
            }
        }
        then("I should see the blast creation form with all channels") {
            let nameInput = find("blast-name-input")
            XCTAssertTrue(
                nameInput.waitForExistence(timeout: 5),
                "Blast name input should appear in create sheet"
            )

            let messageInput = find("blast-message-input")
            XCTAssertTrue(messageInput.exists, "Message input should exist")

            let smsToggle = find("blast-channel-sms")
            XCTAssertTrue(smsToggle.exists, "SMS channel toggle should exist")

            let whatsappToggle = find("blast-channel-whatsapp")
            XCTAssertTrue(whatsappToggle.exists, "WhatsApp channel toggle should exist")

            let signalToggle = find("blast-channel-signal")
            XCTAssertTrue(signalToggle.exists, "Signal channel toggle should exist")

            let sendButton = find("blast-send-button")
            XCTAssertTrue(sendButton.exists, "Send Now button should exist")

            let scheduleButton = find("blast-schedule-button")
            XCTAssertTrue(scheduleButton.exists, "Schedule button should exist")

            let cancelButton = find("cancel-blast-create")
            XCTAssertTrue(cancelButton.exists, "Cancel button should exist")
        }
    }

    // MARK: - Scenario: Schedule button toggles date picker

    func testScheduleButtonTogglesDatePicker() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I open the create blast sheet and tap schedule") {
            scrollAndTap("dashboard-blasts-action")
            _ = anyElementExists(["blasts-list", "blasts-empty-state", "blasts-loading"])

            let createButton = find("create-blast-button")
            if createButton.waitForExistence(timeout: 3) {
                createButton.tap()
            } else {
                let createFirst = find("create-first-blast")
                if createFirst.waitForExistence(timeout: 3) {
                    createFirst.tap()
                }
            }

            let nameInput = find("blast-name-input")
            _ = nameInput.waitForExistence(timeout: 5)

            let scheduleButton = find("blast-schedule-button")
            scheduleButton.tap()
        }
        then("I should see the date picker") {
            let schedulePicker = find("blast-schedule-picker")
            XCTAssertTrue(
                schedulePicker.waitForExistence(timeout: 5),
                "Schedule date picker should appear when schedule button is tapped"
            )

            let confirmSchedule = find("blast-confirm-schedule")
            XCTAssertTrue(confirmSchedule.exists, "Confirm schedule button should appear")
        }
    }

    // MARK: - Scenario: Cancel blast creation

    func testCancelBlastCreation() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I open the create blast sheet and cancel") {
            scrollAndTap("dashboard-blasts-action")
            _ = anyElementExists(["blasts-list", "blasts-empty-state", "blasts-loading"])

            let createButton = find("create-blast-button")
            if createButton.waitForExistence(timeout: 3) {
                createButton.tap()
            } else {
                let createFirst = find("create-first-blast")
                if createFirst.waitForExistence(timeout: 3) {
                    createFirst.tap()
                }
            }

            let nameInput = find("blast-name-input")
            _ = nameInput.waitForExistence(timeout: 5)

            let cancelButton = find("cancel-blast-create")
            cancelButton.tap()
        }
        then("I should be back on the blasts screen") {
            let found = anyElementExists([
                "blasts-list", "blasts-empty-state", "create-blast-button",
            ])
            XCTAssertTrue(found, "Should return to blasts after cancel")
        }
    }

    // MARK: - Scenario: Empty state shows create button

    func testEmptyStateShowsCreateButton() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to blasts") {
            scrollAndTap("dashboard-blasts-action")
            _ = anyElementExists(["blasts-list", "blasts-empty-state", "blasts-loading"])
        }
        then("the empty state should have a create button if no blasts exist") {
            let emptyState = find("blasts-empty-state")
            if emptyState.waitForExistence(timeout: 5) {
                let createFirst = find("create-first-blast")
                XCTAssertTrue(createFirst.exists, "Empty state should have a create button")
            }
            // If blasts exist, that's fine too
        }
    }
}
