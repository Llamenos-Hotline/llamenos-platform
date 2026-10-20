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
            XCTAssertTrue(
                find("shift-status-card").waitForExistence(timeout: 10),
                "Shift status card should exist"
            )
            // A freshly authenticated volunteer has not clocked in.
            let status = find("shift-status-text")
            XCTAssertTrue(status.waitForExistence(timeout: 5), "The card should carry a status label")
            XCTAssertEqual(status.label, "Off Shift", "A volunteer who has not clocked in is off shift")
            XCTAssertFalse(find("shift-elapsed-timer").exists, "There is no elapsed timer off shift")
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

    /// `MainTabView` has six tabs and an iPhone tab bar shows at most five items, so
    /// iOS shows four tabs plus "More". This used to assert six tab-bar BUTTONS, a
    /// layout the app cannot produce on this device class, so it failed on every
    /// run from the first (#1240) while the other tab scenarios — which already
    /// reach Shifts and Settings through More — passed. What a user needs is that
    /// every section is reachable, and that is what this checks: each title is
    /// either a tab-bar button or a row under More. It holds whichever way #1240's
    /// open question (fold a destination elsewhere, or keep More) is decided.
    func testAllTabsExist() {
        let titles = ["Dashboard", "Notes", "Cases", "Messages", "Shifts", "Settings"]
        given("I am authenticated and on the dashboard") {
            // Already on dashboard
        }
        then("every main section is a tab-bar button or listed under More") {
            let tabBar = app.tabBars.firstMatch
            XCTAssertTrue(tabBar.waitForExistence(timeout: 5), "Tab bar should exist")
            let overflow = titles.filter { !tabBar.buttons[$0].exists }
            if !overflow.isEmpty {
                let more = tabBar.buttons["More"]
                XCTAssertTrue(
                    more.exists,
                    "\(overflow) are not tab-bar buttons, so the tab bar must offer More to reach them"
                )
                more.tap()
                if !app.tables.cells.staticTexts[overflow[0]].waitForExistence(timeout: 2) {
                    // More re-opens the overflow tab shown last; tapping it again pops to its list.
                    more.tap()
                }
                for title in overflow {
                    XCTAssertTrue(
                        app.tables.cells.staticTexts[title].waitForExistence(timeout: 5),
                        "\(title) should be listed under More"
                    )
                }
            }
        }
    }

    // PROOF ONLY (branch proof-2057-verify, never merged): MUST fail, naming Reports.
    func testBreakIt_NonexistentSectionMustFail() {
        let titles = ["Dashboard", "Notes", "Cases", "Messages", "Shifts", "Settings", "Reports"]
        given("I am authenticated and on the dashboard") {
            // Already on dashboard
        }
        then("every main section is a tab-bar button or listed under More") {
            let tabBar = app.tabBars.firstMatch
            XCTAssertTrue(tabBar.waitForExistence(timeout: 5), "Tab bar should exist")
            let overflow = titles.filter { !tabBar.buttons[$0].exists }
            if !overflow.isEmpty {
                let more = tabBar.buttons["More"]
                XCTAssertTrue(
                    more.exists,
                    "\(overflow) are not tab-bar buttons, so the tab bar must offer More to reach them"
                )
                more.tap()
                if !app.tables.cells.staticTexts[overflow[0]].waitForExistence(timeout: 2) {
                    // More re-opens the overflow tab shown last; tapping it again pops to its list.
                    more.tap()
                }
                for title in overflow {
                    XCTAssertTrue(
                        app.tables.cells.staticTexts[title].waitForExistence(timeout: 5),
                        "\(title) should be listed under More"
                    )
                }
            }
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
