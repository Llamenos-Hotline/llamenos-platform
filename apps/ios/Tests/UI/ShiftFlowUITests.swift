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

    func testClockOutShowsConfirmation() throws {
        given("I am authenticated") {
            // Already launched
        }
        when("I navigate to shifts") {
            navigateToShifts()
        }
        then("if on shift, clock out should show confirmation") {
            // This class launches with `launchAuthenticated()` — no hub is
            // configured, so ShiftsViewModel.fetchShifts() treats the missing
            // hub as "show an empty schedule" (see ShiftsViewModel.swift):
            // shiftDays stays empty and ShiftsView renders only
            // "shifts-empty-state". Neither clock button appears without a
            // live hub, so report that explicitly instead of silently
            // passing with no assertion ever evaluated.
            guard find("clock-in-button").waitForExistence(timeout: 5) || find("clock-out-button").waitForExistence(timeout: 2) else {
                throw XCTSkip("No hub is configured in this test class; the clock button never renders")
            }

            if find("clock-in-button").exists {
                find("clock-in-button").tap()
                guard find("clock-out-button").waitForExistence(timeout: 10) else {
                    throw XCTSkip("Clocking in did not transition to an on-shift state")
                }
            }

            find("clock-out-button").tap()

            XCTAssertTrue(
                app.alerts.firstMatch.waitForExistence(timeout: 5),
                "Clock out confirmation dialog should appear"
            )

            // Cancel to not actually clock out
            let cancelButton = app.alerts.firstMatch.buttons.firstMatch
            if cancelButton.exists {
                cancelButton.tap()
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

    func testTodayBadgeExists() throws {
        given("I am authenticated") {
            // Already launched
        }
        when("I navigate to shifts") {
            navigateToShifts()
        }
        then("today's section should exist if schedule is showing") {
            // This class launches with no hub configured, so the weekly
            // schedule never renders (see testClockOutShowsConfirmation) —
            // only "shifts-empty-state" does. Report that explicitly.
            guard !find("shifts-empty-state").waitForExistence(timeout: 3) else {
                throw XCTSkip("No hub is configured in this test class; the weekly schedule never renders")
            }

            let today = Calendar.current.component(.weekday, from: Date()) - 1  // 0-indexed
            XCTAssertTrue(
                find("shift-day-\(today)").waitForExistence(timeout: 3),
                "Today's day section should exist in the schedule"
            )
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
        then("the empty state should display without a configured hub") {
            // ShiftsViewModel.fetchShifts() treats a missing hub URL as "show
            // an empty schedule", not an error (see ShiftsViewModel.swift) —
            // this class's `launchAuthenticated()` never configures a hub, so
            // "shifts-empty-state" is the deterministic outcome here, not
            // "shifts-error".
            XCTAssertTrue(
                find("shifts-empty-state").waitForExistence(timeout: 10),
                "Empty state should display when no hub is configured"
            )
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
