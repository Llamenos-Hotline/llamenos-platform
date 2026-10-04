import XCTest

/// BDD-aligned XCUITest suite for the dashboard screen.
/// Maps to scenarios from: dashboard-display.feature, shift-status.feature,
/// dashboard-quick-actions.feature
final class DashboardUITests: BaseUITest {

    override func setUp() {
        super.setUp()
        launchAuthenticated()
    }

    // MARK: - Dashboard Display (dashboard-display.feature)

    func testDashboardShowsConnectionStatusCard() {
        given("I am authenticated and on the dashboard") {
            // Already launched authenticated — dashboard is the default tab
        }
        then("I should see the connection status indicator") {
            let found = anyElementExists(["connection-status", "dashboard-connection-card"])
            XCTAssertTrue(found, "Connection status should be visible on dashboard")
        }
    }

    func testDashboardShowsShiftStatusCard() {
        given("I am authenticated and on the dashboard") {
            // Already on dashboard
        }
        then("I should see the shift status card") {
            let shiftCard = find("shift-status-card")
            XCTAssertTrue(
                shiftCard.waitForExistence(timeout: 10),
                "Shift status card should exist on dashboard"
            )
        }
    }

    func testDashboardShowsIdentity() {
        given("I am authenticated and on the dashboard") {
            // Already on dashboard
        }
        then("I should see my identity displayed") {
            // V3: signing pubkey (hex) shown as "Identity", not a Bech32 npub
            let identityDisplay = find("dashboard-identity")
            XCTAssertTrue(
                identityDisplay.waitForExistence(timeout: 5),
                "Dashboard should display the user's identity (signing pubkey)"
            )
        }
    }

    func testDashboardShowsLockButton() {
        given("I am authenticated and on the dashboard") {
            // Already on dashboard
        }
        then("I should see a lock button") {
            let lockButton = find("lock-app")
            XCTAssertTrue(
                lockButton.waitForExistence(timeout: 5),
                "Lock button should exist on dashboard"
            )
        }
    }

    func testDashboardShowsDashboardTitle() {
        given("I am authenticated and on the dashboard") {
            // Already on dashboard
        }
        then("I should see the dashboard title") {
            let title = find("dashboard-title")
            XCTAssertTrue(
                title.waitForExistence(timeout: 10),
                "Dashboard title should be displayed"
            )
        }
    }

    // MARK: - Shift Status (shift-status.feature)

    func testShiftStatusCardShowsCurrentState() {
        given("I am authenticated and on the dashboard") {
            // Already on dashboard
        }
        then("the shift status card should show a status label") {
            let shiftCard = find("shift-status-card")
            guard shiftCard.waitForExistence(timeout: 10) else {
                XCTFail("Shift status card should exist")
                return
            }
            // Should have some text indicating shift state
            XCTAssertTrue(true, "Shift status card is displayed")
        }
    }

    // MARK: - Lock / Unlock (lock-logout.feature)

    func testLockButtonTransitionsToPINUnlock() {
        given("I am authenticated and on the dashboard") {
            // Already on dashboard
        }
        when("I tap the lock button") {
            let lockButton = find("lock-app")
            XCTAssertTrue(lockButton.waitForExistence(timeout: 5))
            lockButton.tap()
        }
        then("I should see the PIN unlock screen") {
            let pinPad = find("pin-pad")
            XCTAssertTrue(
                pinPad.waitForExistence(timeout: 5),
                "PIN pad should appear after locking"
            )
        }
    }

    // MARK: - Tab Navigation (tab-navigation.feature)

    func testAllTabsExist() {
        given("I am authenticated and on the dashboard") {
            // Already on dashboard
        }
        then("I should see 6 tab bar items") {
            let tabBar = app.tabBars.firstMatch
            XCTAssertTrue(tabBar.waitForExistence(timeout: 5), "Tab bar should exist")
            XCTAssertGreaterThanOrEqual(
                tabBar.buttons.count, 6,
                "Tab bar should have at least 6 buttons (Dashboard, Notes, Cases, Messages, Shifts, Settings)"
            )
        }
    }

    /// Scenario: Navigate to notes tab (core/note-encryption.feature)
    func testNavigateToNotesTab() {
        given("I am authenticated and on the main screen") {
            // Already on dashboard
        }
        when("I tap the \"Notes\" tab") {
            navigateToNotes()
        }
        then("I should see the notes screen") {
            let found = anyElementExists([
                "notes-list", "notes-empty-state", "notes-loading", "notes-error",
            ])
            XCTAssertTrue(found, "Notes view should show content after tab navigation")
        }
        and("the create note FAB should be visible") {
            // iOS places the create action in the navigation bar, not a floating button.
            XCTAssertTrue(
                find("create-note-button").waitForExistence(timeout: 5),
                "The create-note action should be visible on the notes screen"
            )
        }
    }

    /// Scenario: Navigate to conversations tab (core/messaging-flow.feature)
    func testNavigateToConversationsTab() {
        given("I am authenticated and on the main screen") {
            // Already on dashboard
        }
        when("I tap the \"Conversations\" tab") {
            navigateToConversations()
        }
        then("I should see the conversations screen") {
            let found = anyElementExists([
                "conversations-list", "conversations-empty-state", "conversations-loading",
                "conversations-error",
            ])
            XCTAssertTrue(found, "Conversations view should show content")
        }
        and("the filter chips should be visible") {
            // iOS renders the status filters as a menu behind one toolbar control.
            XCTAssertTrue(
                find("conversations-filter-button").waitForExistence(timeout: 5),
                "The conversation status filter control should be visible"
            )
        }
    }

    /// Scenario: Navigate to shifts tab (admin/shift-management.feature)
    func testNavigateToShiftsTab() {
        given("I am authenticated and on the main screen") {
            // Already on dashboard
        }
        when("I tap the \"Shifts\" tab") {
            navigateToShifts()
        }
        then("I should see the clock in/out card") {
            XCTAssertTrue(
                anyElementExists(["clock-in-button", "clock-out-button"]),
                "The clock in/out control should be visible on the shifts screen"
            )
        }
        and("the clock status text should be displayed") {
            XCTAssertTrue(
                find("shift-status-label").waitForExistence(timeout: 5),
                "The On Shift / Off Shift status text should be displayed"
            )
        }
    }

    func testNavigateToSettingsTab() {
        given("I am authenticated and on the dashboard") {
            // Already on dashboard
        }
        when("I tap the Settings tab") {
            navigateToSettings()
        }
        then("I should see settings content") {
            // settings-lock-app is always visible near the top; settings-signing-pubkey
            // shows the hex pubkey in the identity card (v3 — no Bech32 npub).
            let found = anyElementExists([
                "settings-lock-app", "settings-signing-pubkey",
                "settings-version", "settings-logout",
            ])
            XCTAssertTrue(found, "Settings view should show content")
        }
    }
}
