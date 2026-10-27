import XCTest

/// XCUITest suite for the shifts workflow: viewing the shift schedule,
/// clock in/out toggle, and shift signup interactions.
///
/// Offline tests launch authenticated with no hub; the schedule and clock tests connect to the
/// live backend and seed what they assert on through `TestAdminAPI`.
final class ShiftFlowUITests: BaseUITest {

    // MARK: - Tab Navigation

    /// Offline (no hub configured) the schedule cannot load: the tab settles on the
    /// empty state, still shows the clock card, and neither spins nor reports an error.
    func testShiftsTabExists() {
        given("I am authenticated without a hub connection") {
            launchAuthenticated()
        }
        when("I navigate to the Shifts tab") {
            navigateToShifts()
        }
        then("the clock card and the empty schedule are shown, with nothing loading") {
            XCTAssertTrue(
                find("clock-in-button").waitForExistence(timeout: 20),
                "The clock card is rendered whenever the Shifts tab is up"
            )
            XCTAssertTrue(
                find("shifts-empty-state").waitForExistence(timeout: 10),
                "With no hub there is no schedule, so the empty state is shown"
            )
            XCTAssertFalse(find("shifts-loading").exists, "The Shifts tab should have finished loading")
            XCTAssertFalse(find("shifts-error").exists, "No hub configured is not an error")
        }
    }

    // MARK: - Clock In/Out

    func testClockInButtonShownWhenOffShift() {
        given("I am authenticated and not on shift") {
            launchAuthenticated()
        }
        when("I navigate to shifts") {
            navigateToShifts()
        }
        then("I am offered Clock In, not Clock Out") {
            XCTAssertTrue(
                find("clock-in-button").waitForExistence(timeout: 20),
                "An off-shift volunteer should see the clock-in button"
            )
            XCTAssertFalse(find("clock-out-button").exists, "An off-shift volunteer has nothing to clock out of")
        }
    }

    func testShiftStatusShowsOffShift() {
        given("I am authenticated and not on shift") {
            launchAuthenticated()
        }
        when("I navigate to shifts") {
            navigateToShifts()
        }
        then("the status label reads Off Shift") {
            let status = find("shift-status-label")
            XCTAssertTrue(status.waitForExistence(timeout: 20), "The shift status label should be shown")
            XCTAssertEqual(status.label, "Off Shift", "A volunteer who has not clocked in is off shift")
            XCTAssertFalse(find("shift-elapsed-time").exists, "There is no elapsed timer off shift")
        }
    }

    func testClockOutShowsConfirmation() {
        given("I am connected to the API and clocked in") {
            launchAsVolunteerWithAPI()
            navigateToShifts()
            let clockIn = find("clock-in-button")
            XCTAssertTrue(clockIn.waitForExistence(timeout: 20), "The clock-in button should exist")
            clockIn.tap()
            XCTAssertTrue(
                find("clock-out-button").waitForExistence(timeout: 20),
                "Clocking in should put the volunteer on shift"
            )
        }
        when("I tap Clock Out") {
            find("clock-out-button").tap()
        }
        then("I am asked to confirm before the shift ends") {
            let alert = app.alerts["End Shift?"]
            XCTAssertTrue(alert.waitForExistence(timeout: 5), "Clock out should ask for confirmation")
            XCTAssertTrue(alert.buttons["Cancel"].exists, "The confirmation should offer Cancel")
            XCTAssertTrue(alert.buttons["Clock Out"].exists, "The confirmation should offer Clock Out")

            // Cancelling must leave the volunteer on shift.
            alert.buttons["Cancel"].tap()
            XCTAssertFalse(alert.waitForExistence(timeout: 2), "Cancel should dismiss the confirmation")
            XCTAssertTrue(
                find("clock-out-button").exists,
                "Cancelling the confirmation should not end the shift"
            )
        }
    }

    // MARK: - Weekly Schedule

    /// Put a shift that runs every day on the class hub and return its id.
    private func seedShiftEveryDay() -> String {
        let shiftId = UUID().uuidString.lowercased()
        TestAdminAPI.send(
            "POST", "/api/hubs/\(testHubId)/shifts",
            [
                "id": shiftId,
                "encryptedName": "Schedule \(shiftId.prefix(8))",
                "startTime": "00:00",
                "endTime": "23:59",
                "days": [0, 1, 2, 3, 4, 5, 6],
                "userPubkeys": [],
            ],
            baseURL: testHubURL
        )
        return shiftId
    }

    func testWeeklyScheduleHeader() {
        var shiftId = ""
        given("the hub has a shift scheduled every day") {
            shiftId = seedShiftEveryDay()
        }
        when("I connect as a volunteer and open the shifts tab") {
            launchAsVolunteerWithAPI()
            navigateToShifts()
        }
        then("the weekly schedule is shown and lists that shift") {
            let header = scrollToFind("weekly-schedule-header", maxSwipes: 6, timeout: 20)
            XCTAssertTrue(header.exists, "A hub with a schedule should show the weekly schedule")
            let card = scrollToFind("shift-card-\(shiftId)", maxSwipes: 6, timeout: 10)
            XCTAssertTrue(card.exists, "The seeded shift should be listed in the schedule")
            XCTAssertFalse(find("shifts-empty-state").exists, "A loaded schedule is not the empty state")
        }
    }

    func testTodayBadgeExists() {
        given("I am connected as a volunteer") {
            launchAsVolunteerWithAPI()
        }
        when("I open the shifts tab") {
            navigateToShifts()
        }
        then("today's day section carries the Today badge") {
            let today = Calendar.current.component(.weekday, from: Date()) - 1  // 0-indexed
            let todaySection = scrollToFind("shift-day-\(today)", maxSwipes: 10, timeout: 15)
            XCTAssertTrue(todaySection.exists, "Today's day section should exist in the schedule")
            let badge = app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "Today")).firstMatch
            XCTAssertTrue(badge.waitForExistence(timeout: 5), "Today's section should be marked with the Today badge")
        }
    }

    // MARK: - Error State

    /// A hub that cannot be reached is an error, not an empty schedule: the volunteer is
    /// told the schedule failed to load. Port 9 (discard) has no listener, so the
    /// request is refused at the socket.
    func testErrorMessageDisplays() {
        given("I am authenticated against a hub that cannot be reached") {
            app.launchArguments.append(contentsOf: [
                "--reset-keychain", "--test-authenticated",
                "--test-hub-url", "http://127.0.0.1:9",
            ])
            app.launchToFirstScreen()
            XCTAssertTrue(find("main-tab-view").waitForExistence(timeout: 60))
        }
        when("I navigate to shifts") {
            navigateToShifts()
        }
        then("the failure is reported and no schedule is shown") {
            XCTAssertTrue(
                find("shifts-error").waitForExistence(timeout: 30),
                "A hub connection failure should be reported on the Shifts tab"
            )
            XCTAssertTrue(find("shifts-empty-state").exists, "No schedule could be loaded")
        }
    }

    // MARK: - Settings Tab

    func testSettingsTabShowsIdentity() {
        given("I am authenticated") {
            launchAuthenticated()
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
            launchAuthenticated()
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
            launchAuthenticated()
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
