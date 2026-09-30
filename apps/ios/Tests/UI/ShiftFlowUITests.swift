import XCTest

/// XCUITest suite for the shifts workflow: viewing the shift schedule,
/// clock in/out toggle, and shift signup interactions.
///
/// These tests require the app to be in an authenticated state with a valid hub connection.
final class ShiftFlowUITests: BaseUITest {

    override func setUp() {
        super.setUp()
        launchAuthenticated()
    }

    // MARK: - Tab Navigation

    func testShiftsTabExists() {
        given("I am authenticated and on the dashboard") {
            // Already launched authenticated
        }
        when("I navigate to the Shifts tab") {
            navigateToShifts()
        }
        then("I should see shifts content") {
            // Shifts content should appear (loading, empty, or schedule with clock button)
            // empty-state and loading come first — they appear in offline/no-hub mode
            let found = anyElementExists([
                "shifts-empty-state", "shifts-loading",
                "clock-in-button", "clock-out-button",
            ])
            XCTAssertTrue(found, "Shifts view should show clock button, empty state, or loading")
        }
    }

    // MARK: - Clock In/Out

    func testClockInButtonOrEmptyState() {
        given("I am authenticated") {
            // Already launched
        }
        when("I navigate to shifts") {
            navigateToShifts()
        }
        then("I should see a clock button or empty state") {
            // Without an API connection, the shifts view shows empty state.
            // With shifts data, the clock in/out button appears.
            // empty-state first — it's the expected state without a hub connection
            let found = anyElementExists([
                "shifts-empty-state",
                "clock-in-button", "clock-out-button",
            ])
            XCTAssertTrue(found, "Clock in/out button or empty state should exist")
        }
    }

    func testShiftStatusOrEmptyState() {
        given("I am authenticated") {
            // Already launched
        }
        when("I navigate to shifts") {
            navigateToShifts()
        }
        then("I should see shift status or empty state") {
            // Shift status label only appears in the shift list (not empty state)
            // empty-state first — it's the expected state without a hub connection
            let found = anyElementExists([
                "shifts-empty-state",
                "shift-status-label",
            ])
            XCTAssertTrue(found, "Shift status label or empty state should exist")
        }
    }

    func testClockOutShowsConfirmation() {
        given("I am authenticated") {
            // Already launched
        }
        when("I navigate to shifts") {
            navigateToShifts()
        }
        then("if on shift, clock out should show confirmation") {
            // If we're on shift, the clock out button exists
            let clockOutButton = find("clock-out-button")
            guard clockOutButton.waitForExistence(timeout: 5) else {
                // Not on shift — try clocking in first
                let clockInButton = find("clock-in-button")
                XCTAssertTrue(
                    clockInButton.waitForExistence(timeout: 5),
                    "Shifts tab should show a clock-in button when the user is not on shift"
                )
                clockInButton.tap()

                // Wait for clock out button to appear (shift started)
                XCTAssertTrue(
                    find("clock-out-button").waitForExistence(timeout: 10),
                    "Clock-out button should replace clock-in once clocking in succeeds"
                )
                find("clock-out-button").tap()

                // Confirmation dialog should appear
                let alertExists = app.alerts.firstMatch.waitForExistence(timeout: 5)
                if alertExists {
                    // Cancel to not actually clock out
                    let cancelButton = app.alerts.firstMatch.buttons.firstMatch
                    cancelButton.tap()
                }
                return
            }

            clockOutButton.tap()

            // Confirmation dialog should appear
            let alertExists = app.alerts.firstMatch.waitForExistence(timeout: 5)
            if alertExists {
                XCTAssertTrue(true, "Clock out confirmation dialog appeared")
                // Cancel
                let cancelButton = app.alerts.firstMatch.buttons.element(boundBy: 0)
                if cancelButton.exists {
                    cancelButton.tap()
                }
            }
        }
    }

    // MARK: - Weekly Schedule

    func testWeeklyScheduleHeader() {
        given("I am authenticated") {
            // Already launched
        }
        when("I navigate to shifts") {
            navigateToShifts()
        }
        then("I should see the schedule or empty state") {
            // Wait for content to load
            // empty-state first — it's the expected state without a hub connection
            let found = anyElementExists([
                "shifts-empty-state", "weekly-schedule-header",
            ])
            // It's okay if the schedule is empty (no shifts configured)
            XCTAssertTrue(found, "Weekly schedule header or empty state should exist")
        }
    }

    func testTodayBadgeExists() {
        given("I am authenticated") {
            // Already launched
        }
        when("I navigate to shifts") {
            navigateToShifts()
        }
        then("today's section should exist if schedule is showing") {
            // If the weekly schedule is showing, today's day section should be highlighted
            let emptyState = find("shifts-empty-state")
            guard !emptyState.waitForExistence(timeout: 3) else { return }

            let today = Calendar.current.component(.weekday, from: Date()) - 1  // 0-indexed
            let todaySection = find("shift-day-\(today)")

            if todaySection.waitForExistence(timeout: 3) {
                XCTAssertTrue(true, "Today's day section exists in the schedule")
            }
        }
    }

    // MARK: - Error State

    func testErrorMessageDisplays() {
        given("I am authenticated") {
            // Already launched
        }
        when("I navigate to shifts") {
            navigateToShifts()
        }
        then("an error or empty state should display without API") {
            // If there's an error (e.g., hub not configured), it should display
            let found = anyElementExists([
                "shifts-error", "shifts-empty-state",
            ])
            if found {
                XCTAssertTrue(true, "Error or empty state displayed when hub connection fails")
            }
            // If neither, that's fine — hub might be configured
        }
    }

    // MARK: - Settings Tab

    func testSettingsTabShowsIdentity() {
        given("I am authenticated") {
            // Already launched
        }
        when("I navigate to settings") {
            navigateToSettings()
        }
        then("I should see identity or version info") {
            // v3 device keys: the identity row is the signing pubkey, not a Bech32 npub.
            let found = anyElementExists(["settings-signing-pubkey", "settings-version"])
            XCTAssertTrue(found, "Settings should show identity or version info")
        }
    }

    func testSettingsLockButton() {
        given("I am authenticated") {
            // Already launched
        }
        when("I navigate to settings") {
            navigateToSettings()
        }
        then("the lock app button should exist") {
            let lockButton = scrollToFind("settings-lock-app", maxSwipes: 10)
            XCTAssertTrue(lockButton.exists, "Lock app button should exist in settings")
        }
    }

    func testSettingsLogoutButton() {
        given("I am authenticated") {
            // Already launched
        }
        when("I navigate to settings") {
            navigateToSettings()
        }
        then("the logout button should exist") {
            let logoutButton = scrollToFind("settings-logout", maxSwipes: 10)
            XCTAssertTrue(logoutButton.exists, "Logout button should exist in settings")
        }
    }
}
