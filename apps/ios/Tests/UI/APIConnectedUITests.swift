import XCTest

/// E2E tests that connect to the real Docker Compose backend.
/// These verify actual API communication, WebSocket connections,
/// and server-side behavior (notes, shifts, settings persistence,
/// call simulation, and message simulation).
///
/// Requires Docker Compose backend running on localhost:3000.
/// Override with TEST_HUB_URL environment variable if needed.
final class APIConnectedUITests: BaseUITest {

    /// The mock identity pubkey matching ADMIN_PUBKEY in Docker .env.
    /// Used for call simulation endpoints that require a pubkey parameter.
    private let mockPubkey = "79215a4c04f08fcd817c6f820c87169beb8cddf96dfa590a1315556b78af9183"

    // MARK: - Connection & Bootstrap

    func testVolunteerBootstrapsAndSeesConnected() {
        given("I launch the app connected to the API as a volunteer") {
            launchWithAPI()
        }
        then("I should see the dashboard with a connected status") {
            let dashboard = find("dashboard-title")
            XCTAssertTrue(
                dashboard.waitForExistence(timeout: 15),
                "Dashboard should appear after API bootstrap"
            )

            // Check connection indicator shows connected (green dot or text)
            let connected = anyElementExists(["connection-status", "dashboard-connection-card"])
            XCTAssertTrue(connected, "Connection status should be visible")
        }
    }

    func testAdminBootstrapsAndSeesAdminFeatures() {
        given("I launch the app connected to the API as an admin") {
            launchAsAdminWithAPI()
        }
        then("I should see admin-specific UI elements") {
            let dashboard = find("dashboard-title")
            XCTAssertTrue(
                dashboard.waitForExistence(timeout: 15),
                "Dashboard should appear after admin API bootstrap"
            )

            navigateToSettings()
            let adminLink = scrollToFind("settings-admin-link", maxSwipes: 3, timeout: 10)
            XCTAssertTrue(
                adminLink.exists,
                "Admin panel link should be visible for admin users"
            )
        }
    }

    // MARK: - Dashboard API Data

    func testDashboardLoadsFromAPI() {
        given("I am connected to the API") {
            launchAsAdminWithAPI()
        }
        when("the dashboard loads") {
            let dashboard = find("dashboard-title")
            XCTAssertTrue(dashboard.waitForExistence(timeout: 15))
        }
        then("shift and connection cards should display server data") {
            let shiftCard = find("shift-status-card")
            XCTAssertTrue(
                shiftCard.waitForExistence(timeout: 10),
                "Shift status card should load with API data"
            )
        }
    }

    func testDashboardShowsIdentityWithAPI() {
        given("I am connected to the API") {
            launchWithAPI()
        }
        then("I should see my identity on the dashboard") {
            let dashboard = find("dashboard-title")
            XCTAssertTrue(dashboard.waitForExistence(timeout: 15))

            // v3 device keys: the identity is the signing pubkey (hex), not a Bech32 npub.
            let identity = find("dashboard-identity")
            XCTAssertTrue(
                identity.waitForExistence(timeout: 5),
                "Dashboard should display the user's identity with API connection"
            )
        }
    }

    func testDashboardShowsLockButtonWithAPI() {
        given("I am connected to the API") {
            launchWithAPI()
        }
        then("I should see a lock button on the dashboard") {
            let dashboard = find("dashboard-title")
            XCTAssertTrue(dashboard.waitForExistence(timeout: 15))

            let lockButton = find("lock-app")
            XCTAssertTrue(
                lockButton.waitForExistence(timeout: 5),
                "Lock button should exist on dashboard with API"
            )
        }
    }

    func testAllTabsExistWithAPI() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        then("I should see 5 tab bar items") {
            let tabBar = app.tabBars.firstMatch
            XCTAssertTrue(tabBar.waitForExistence(timeout: 5), "Tab bar should exist")
            XCTAssertGreaterThanOrEqual(
                tabBar.buttons.count, 5,
                "Tab bar should have at least 5 buttons"
            )
        }
    }

    // MARK: - Notes CRUD via API

    func testCreateNoteWithAPIConnection() {
        given("I am connected as a volunteer") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to notes and create a new note") {
            navigateToNotes()

            // Look for create/add note button
            let addNote = anyElement(["create-note-button", "add-note-button", "new-note-fab"])
            guard addNote.waitForExistence(timeout: 10) else {
                // May be empty state with create action
                let emptyAction = find("create-first-note")
                if emptyAction.waitForExistence(timeout: 5) {
                    emptyAction.tap()
                    return
                }
                XCTFail("Could not find create note action")
                return
            }
            addNote.tap()
        }
        then("I should see the note creation form") {
            let noteForm = anyElementExists([
                "note-text-editor", "save-note", "cancel-note-create",
            ])
            XCTAssertTrue(noteForm, "Note creation form should appear")
        }
    }

    func testCreateNoteWithTextViaAPI() {
        given("I am connected as a volunteer") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to notes and enter text in a new note") {
            navigateToNotes()

            let createButton = anyElement(["create-note-button", "create-first-note"])
            guard createButton.waitForExistence(timeout: 10) else {
                XCTFail("Could not find create note button")
                return
            }
            createButton.tap()

            let textEditor = find("note-text-editor")
            XCTAssertTrue(textEditor.waitForExistence(timeout: 5))
            typeText("API test note - \(Date().timeIntervalSince1970)", into: textEditor)
        }
        then("the save button should be enabled") {
            let saveButton = find("save-note")
            XCTAssertTrue(saveButton.exists, "Save button should exist")
            XCTAssertTrue(saveButton.isEnabled, "Save button should be enabled with text")
        }
    }

    func testCancelNoteCreationViaAPI() {
        given("I am connected as a volunteer") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I open the note creation form, type text and cancel") {
            navigateToNotes()

            let createButton = anyElement(["create-note-button", "create-first-note"])
            XCTAssertTrue(createButton.waitForExistence(timeout: 10), "A create-note action should be on the Notes tab")
            createButton.tap()

            let textEditor = find("note-text-editor")
            XCTAssertTrue(textEditor.waitForExistence(timeout: 5), "The create sheet should open")
            typeText("Draft that must not be saved", into: textEditor)

            find("cancel-note-create").tap()
        }
        then("the sheet is gone and nothing was saved") {
            XCTAssertTrue(
                find("note-text-editor").waitForNonExistence(timeout: 10),
                "Cancel should dismiss the create sheet"
            )
            XCTAssertFalse(
                app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Draft that must not be saved"))
                    .firstMatch.exists,
                "A cancelled draft must not appear in the notes list"
            )
            XCTAssertFalse(find("note-create-error").exists, "Cancelling should not talk to the server")
        }
    }

    // MARK: - Shifts via API

    func testShiftsLoadFromAPI() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to the shifts tab") {
            navigateToShifts()
        }
        then("I should see the shift clock UI or empty state") {
            let found = anyElementExists([
                "clock-in-button", "clock-out-button", "shifts-empty-state",
            ])
            XCTAssertTrue(found, "Shifts tab should load with API data or show empty state")
        }
    }

    func testClockInViaAPI() {
        given("I am connected to the API as a volunteer who is off shift") {
            launchAsVolunteerWithAPI()
            navigateToShifts()
            XCTAssertTrue(
                find("clock-in-button").waitForExistence(timeout: 20),
                "An off-shift volunteer should be offered Clock In"
            )
        }
        when("I tap clock in") {
            find("clock-in-button").tap()
        }
        then("the server records the clock-in and the app offers Clock Out") {
            XCTAssertTrue(
                find("clock-out-button").waitForExistence(timeout: 20),
                "Clocking in should put the volunteer on shift"
            )
            XCTAssertFalse(find("clock-in-button").exists, "An on-shift volunteer has nothing to clock in to")
            XCTAssertFalse(find("shifts-error").exists, "The clock-in request should not report an error")
            // The volunteer is clocked in but no scheduled shift covers them, so the server's
            // ring set (scheduled ∩ clocked in) does not contain them. "On Shift" here would
            // tell a volunteer they are taking calls while callers reach voicemail (#2204).
            XCTAssertEqual(
                find("shift-status-label").label, "Off Shift",
                "A clocked-in volunteer with no covering shift is not rung, so the label must not read On Shift"
            )
            XCTAssertTrue(
                find("shift-readiness-explanation").waitForExistence(timeout: 5),
                "The screen should say why calls will not ring this volunteer"
            )
        }
    }

    func testClockOutConfirmationViaAPI() {
        given("I am connected to the API as a volunteer and clocked in") {
            launchAsVolunteerWithAPI()
            navigateToShifts()
            let clockIn = find("clock-in-button")
            XCTAssertTrue(clockIn.waitForExistence(timeout: 20), "An off-shift volunteer should be offered Clock In")
            clockIn.tap()
            XCTAssertTrue(
                find("clock-out-button").waitForExistence(timeout: 20),
                "Clocking in should put the volunteer on shift"
            )
        }
        when("I clock out and confirm") {
            find("clock-out-button").tap()
            let alert = app.alerts["End Shift?"]
            XCTAssertTrue(alert.waitForExistence(timeout: 5), "Clock out should ask for confirmation")
            alert.buttons["Clock Out"].tap()
        }
        then("the server ends the shift and the app is off shift again") {
            XCTAssertTrue(
                find("clock-in-button").waitForExistence(timeout: 20),
                "Confirming clock out should put the volunteer off shift"
            )
            XCTAssertFalse(find("clock-out-button").exists, "An off-shift volunteer has nothing to clock out of")
            XCTAssertEqual(find("shift-status-label").label, "Off Shift")
            XCTAssertFalse(find("shifts-error").exists, "The clock-out request should not report an error")
        }
    }

    func testShiftStatusWithAPI() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to shifts") {
            navigateToShifts()
        }
        then("I should see shift status or empty state") {
            let found = anyElementExists([
                "shift-status-label", "shifts-empty-state",
            ])
            XCTAssertTrue(found, "Shift status label or empty state should exist with API")
        }
    }

    // MARK: - Settings Persistence via API

    func testSettingsShowsHubURL() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to settings") {
            navigateToSettings()
        }
        then("I should see the hub URL in the identity card") {
            let hubURL = find("settings-hub-url")
            XCTAssertTrue(
                hubURL.waitForExistence(timeout: 5),
                "Hub URL should be displayed in settings"
            )
        }
    }

    func testSettingsShowsConnectionState() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to settings") {
            navigateToSettings()
        }
        then("I should see the connection status") {
            let connection = find("settings-connection")
            XCTAssertTrue(
                connection.waitForExistence(timeout: 5),
                "Connection status should be displayed in settings"
            )
        }
    }

    func testSettingsShowsSigningPubkeyWithAPI() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to settings") {
            navigateToSettings()
        }
        then("I should see my signing pubkey") {
            // v3 device keys: the identity is the signing pubkey (hex), not a Bech32 npub.
            let pubkeyRow = find("settings-signing-pubkey")
            XCTAssertTrue(
                pubkeyRow.waitForExistence(timeout: 10),
                "Settings should display the signing pubkey with API connection"
            )
        }
    }

    func testSettingsShowsRoleWithAPI() {
        given("I am connected to the API as admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to settings") {
            navigateToSettings()
        }
        then("I should see my role") {
            let roleRow = find("settings-role")
            XCTAssertTrue(
                roleRow.waitForExistence(timeout: 10),
                "Role display should exist in settings with API"
            )
        }
    }

    func testSettingsVersionWithAPI() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to settings") {
            navigateToSettings()
        }
        then("I should see the app version") {
            let versionRow = scrollToFind("settings-version")
            XCTAssertTrue(
                versionRow.exists,
                "Version info should be displayed with API"
            )
        }
    }

    func testSettingsLockAndLogoutWithAPI() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to settings") {
            navigateToSettings()
        }
        then("I should see lock and logout buttons") {
            let lockButton = scrollToFind("settings-lock-app")
            XCTAssertTrue(lockButton.exists, "Lock app button should exist with API")

            let logoutButton = scrollToFind("settings-logout")
            XCTAssertTrue(logoutButton.exists, "Logout button should exist with API")
        }
    }

    func testLockFromSettingsWithAPI() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to settings and tap lock") {
            navigateToSettings()
            let lockButton = scrollToFind("settings-lock-app")
            XCTAssertTrue(lockButton.exists, "Lock button should exist")
            lockButton.tap()
        }
        then("I should see the PIN unlock screen") {
            let pinPad = find("pin-pad")
            XCTAssertTrue(
                pinPad.waitForExistence(timeout: 5),
                "PIN pad should appear after locking from settings"
            )
        }
    }

    // MARK: - Conversations via API

    func testConversationsLoadFromAPI() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to conversations") {
            navigateToConversations()
        }
        then("I should see conversations list or empty state") {
            let found = anyElementExists([
                "conversations-list", "conversations-empty-state",
            ])
            XCTAssertTrue(found, "Conversations should load from API")
        }
    }

    func testConversationsFilterButtonWithAPI() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to conversations") {
            navigateToConversations()

            // Wait for content to load
            _ = anyElementExists([
                "conversations-list", "conversations-empty-state",
            ])
        }
        then("I should see the filter button") {
            let filterButton = find("conversations-filter-button")
            XCTAssertTrue(
                filterButton.waitForExistence(timeout: 5),
                "Filter button should exist in the conversations toolbar with API"
            )
        }
    }

    // MARK: - Admin API Features

    func testAdminCanAccessAdminPanel() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            XCTAssertTrue(dashboard.waitForExistence(timeout: 15), "Dashboard should load")
        }
        when("I navigate to the admin panel") {
            navigateToAdminPanel()
        }
        then("I should see the admin panel") {
            let found = anyElementExists([
                "admin-tab-view", "admin-volunteers",
                "admin-bans", "admin-custom-fields",
            ])
            XCTAssertTrue(found, "Admin panel should load")
        }
    }

    func testAdminVolunteersTabViaAPI() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to the admin panel and tap Volunteers") {
            navigateToAdminPanel()

            let volunteersLink = find("admin-volunteers")
            XCTAssertTrue(volunteersLink.waitForExistence(timeout: 5), "volunteersLink should exist")
            volunteersLink.tap()
        }
        then("I should see the volunteers list or empty state") {
            let found = anyElementExists([
                "volunteers-list", "volunteers-empty-state",
            ])
            XCTAssertTrue(found, "Volunteers view should show list or empty state via API")
        }
    }

    func testAdminBansTabViaAPI() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to the admin panel and tap Bans") {
            navigateToAdminPanel()

            let bansLink = find("admin-bans")
            XCTAssertTrue(bansLink.waitForExistence(timeout: 5), "bansLink should exist")
            bansLink.tap()
        }
        then("I should see the ban list or empty state") {
            let found = anyElementExists([
                "ban-list", "bans-empty-state",
            ])
            XCTAssertTrue(found, "Ban list view should show list or empty state via API")
        }
    }

    func testAdminAddBanButtonViaAPI() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to the bans tab") {
            navigateToAdminPanel()

            let bansLink = find("admin-bans")
            XCTAssertTrue(bansLink.waitForExistence(timeout: 5), "bansLink should exist")
            bansLink.tap()

            _ = anyElementExists(["ban-list", "bans-empty-state"])
        }
        then("I should see the add ban button") {
            let found = anyElementExists(["add-ban-button", "add-first-ban"], timeout: 5)
            XCTAssertTrue(found, "Add ban button should exist via API")
        }
    }

    func testAdminAuditLogTabViaAPI() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to the admin panel and tap Audit Log") {
            navigateToAdminPanel()

            let auditLink = find("admin-audit-log")
            XCTAssertTrue(auditLink.waitForExistence(timeout: 5), "auditLink should exist")
            auditLink.tap()
        }
        then("I should see the audit log or empty state") {
            let found = anyElementExists([
                "audit-log-list", "audit-empty-state",
            ])
            XCTAssertTrue(found, "Audit log view should load via API")
        }
    }

    func testAdminInvitesTabViaAPI() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to the admin panel and tap Invites") {
            navigateToAdminPanel()

            let invitesLink = find("admin-invites")
            XCTAssertTrue(invitesLink.waitForExistence(timeout: 5), "invitesLink should exist")
            invitesLink.tap()
        }
        then("I should see the invites list or empty state") {
            let found = anyElementExists([
                "invites-list", "invites-empty-state",
            ])
            XCTAssertTrue(found, "Invites view should load via API")
        }
    }

    func testAdminCreateInviteButtonViaAPI() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to invites") {
            navigateToAdminPanel()

            let invitesLink = find("admin-invites")
            XCTAssertTrue(invitesLink.waitForExistence(timeout: 5), "invitesLink should exist")
            invitesLink.tap()

            _ = anyElementExists(["invites-list", "invites-empty-state"])
        }
        then("I should see the create invite button") {
            let found = anyElementExists(["create-invite-button", "create-first-invite"], timeout: 5)
            XCTAssertTrue(found, "Create invite button should exist via API")
        }
    }

    func testAdminCustomFieldsTabViaAPI() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to the admin panel and tap Custom Fields") {
            navigateToAdminPanel()

            let customFieldsLink = find("admin-custom-fields")
            guard customFieldsLink.waitForExistence(timeout: 5) else {
                XCTFail("Custom Fields link should exist in admin panel")
                return
            }
            customFieldsLink.tap()
        }
        then("I should see the custom fields list or empty state") {
            let found = anyElementExists([
                "custom-fields-list", "custom-fields-empty-state",
            ])
            XCTAssertTrue(found, "Custom fields view should load via API")
        }
    }

    func testAdminCustomFieldsAddButtonViaAPI() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to custom fields") {
            navigateToAdminPanel()

            let customFieldsLink = find("admin-custom-fields")
            XCTAssertTrue(customFieldsLink.waitForExistence(timeout: 5), "customFieldsLink should exist")
            customFieldsLink.tap()

            _ = anyElementExists([
                "custom-fields-list", "custom-fields-empty-state",
            ])
        }
        then("I should see the add field button") {
            let addButton = anyElementExists(["add-field-button", "add-first-field"], timeout: 5)
            XCTAssertTrue(addButton, "Add field button should exist via API")
        }
    }

    // MARK: - Reports via API

    func testReportsQuickActionWithAPI() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        then("the dashboard should show a reports quick action") {
            let reportsAction = scrollToFind("dashboard-reports-action")
            XCTAssertTrue(
                reportsAction.exists,
                "Dashboard should have a reports quick action card with API"
            )
        }
    }

    func testReportsListViaAPI() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to reports") {
            scrollAndTap("dashboard-reports-action")
        }
        then("I should see the reports list or empty state") {
            let found = anyElementExists([
                "reports-list", "reports-empty-state",
            ])
            XCTAssertTrue(found, "Reports view should load via API")
        }
    }

    func testCreateReportFormViaAPI() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to reports and tap create") {
            scrollAndTap("dashboard-reports-action")
            _ = anyElementExists([
                "reports-list", "reports-empty-state",
            ])

            let createButton = find("create-report-button")
            XCTAssertTrue(createButton.waitForExistence(timeout: 5), "createButton should exist")
            createButton.tap()
        }
        then("I should see the report creation form") {
            let titleInput = find("report-title-input")
            XCTAssertTrue(
                titleInput.waitForExistence(timeout: 5),
                "Report title input should appear via API"
            )

            let bodyInput = find("report-body-input")
            XCTAssertTrue(bodyInput.waitForExistence(timeout: 3), "Report body input should exist")

            let submitButton = find("report-submit-button")
            XCTAssertTrue(submitButton.exists, "Submit button should exist")
        }
    }

    // MARK: - Contacts via API (Admin Only)

    func testContactsQuickActionVisibleForAdminWithAPI() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        then("the dashboard should show a contacts quick action") {
            let contactsAction = scrollToFind("dashboard-contacts-action")
            XCTAssertTrue(
                contactsAction.exists,
                "Dashboard should have a contacts quick action card for admin via API"
            )
        }
    }

    func testContactsHiddenForVolunteerWithAPI() {
        given("I am connected as a volunteer") {
            launchAsVolunteerWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        then("the dashboard should not show a contacts quick action") {
            let contactsAction = find("dashboard-contacts-action")
            XCTAssertFalse(
                contactsAction.waitForExistence(timeout: 3),
                "Dashboard should not have contacts quick action for volunteer via API"
            )
        }
    }

    // MARK: - Blasts via API (Admin Only)

    func testBlastsQuickActionVisibleForAdminWithAPI() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        then("the dashboard should show a blasts quick action") {
            let blastsAction = scrollToFind("dashboard-blasts-action")
            XCTAssertTrue(
                blastsAction.exists,
                "Dashboard should have a blasts quick action card for admin via API"
            )
        }
    }

    func testBlastsListViaAPI() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to blasts") {
            scrollAndTap("dashboard-blasts-action")
        }
        then("I should see the blasts list or empty state") {
            let found = anyElementExists([
                "blasts-list", "blasts-empty-state",
            ])
            XCTAssertTrue(found, "Blasts view should load via API")
        }
    }

    func testCreateBlastButtonViaAPI() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to blasts") {
            scrollAndTap("dashboard-blasts-action")
            _ = anyElementExists(["blasts-list", "blasts-empty-state"])
        }
        then("I should see the create blast button") {
            let found = anyElementExists(["create-blast-button", "create-first-blast"], timeout: 5)
            XCTAssertTrue(found, "Create blast button should exist via API")
        }
    }

    // MARK: - Help via API

    func testHelpScreenViaAPI() {
        given("I am connected to the API") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to help via settings") {
            navigateToSettings()
            let helpButton = scrollToFind("settings-help")
            XCTAssertTrue(helpButton.exists, "helpButton should exist")
            helpButton.tap()
        }
        then("I should see the help screen") {
            let helpScreen = find("help-screen")
            XCTAssertTrue(helpScreen.waitForExistence(timeout: 5), "Help screen should be visible via API")

            let securitySection = find("help-security-section")
            XCTAssertTrue(securitySection.waitForExistence(timeout: 5), "Security section should exist")
        }
    }

    func testAdminHelpGuideViaAPI() {
        given("I am connected as an admin") {
            launchAsAdminWithAPI()
            let dashboard = find("dashboard-title")
            _ = dashboard.waitForExistence(timeout: 15)
        }
        when("I navigate to help via settings") {
            navigateToSettings()
            let helpButton = scrollToFind("settings-help")
            XCTAssertTrue(helpButton.exists, "helpButton should exist")
            helpButton.tap()
        }
        then("I should see the admin guide section") {
            let adminGuide = scrollToFind("help-admin-guide")
            XCTAssertTrue(
                adminGuide.waitForExistence(timeout: 5),
                "Admin guide should exist for admin users via API"
            )
        }
    }

    // MARK: - Call Simulation Tests

    func testSimulateIncomingCallAppearance() {
        var hubId = ""
        given("I am connected to the API on a hub with no calls") {
            hubId = launchAsAdminOnFreshHub(named: "incoming-call") ?? ""
            XCTAssertTrue(find("dashboard-title").waitForExistence(timeout: 15), "Dashboard should load")
            XCTAssertFalse(find("active-call-card").exists, "No call card should show before a call exists")
        }
        when("an incoming call is simulated") {
            _ = ringCall(callerNumber: "+15551110001", hubId: hubId)
        }
        then("the dashboard shows a ring, not an active call, and does not name the caller") {
            XCTAssertTrue(
                find("incoming-call-card").waitForExistence(timeout: 20),
                "The ring event should put the call on the dashboard as an incoming call"
            )
            XCTAssertFalse(find("active-call-card").exists, "A ringing call is not a call in progress")
            XCTAssertFalse(app.staticTexts["0001"].exists, "A ring must not show the caller's digits")
        }
    }

    func testSimulateAnswerCallStatusChange() {
        var hubId = ""
        var callId = ""
        given("I am connected to the API on a hub with a ringing call") {
            hubId = launchAsAdminOnFreshHub(named: "answer-call") ?? ""
            XCTAssertTrue(find("dashboard-title").waitForExistence(timeout: 15))
            callId = ringCall(callerNumber: "+15551110002", hubId: hubId)
            XCTAssertTrue(find("incoming-call-card").waitForExistence(timeout: 20))
        }
        when("the call is answered by my identity") {
            let status = simulateAnswerCall(callId: callId, pubkey: appIdentityPubkey())
            XCTAssertEqual(status, "in-progress", "Answered call status should be in-progress")
        }
        then("the server holds the call in progress and the app still shows it") {
            let held = serverActiveCalls(hubId: hubId).first { $0.id == callId }
            XCTAssertEqual(held?.status, "in-progress")
            XCTAssertEqual(held?.answeredBy, appIdentityPubkey())
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 10), "The answered call should become my call on the dashboard")
            XCTAssertTrue(find("call-elapsed-timer").exists, "An in-progress call runs an elapsed timer")
            XCTAssertTrue(waitForCallCardToClear("incoming-call-card"), "The ring should be replaced by the call")
        }
    }

    func testSimulateEndCallStatusChange() {
        var hubId = ""
        var callId = ""
        given("I am connected to the API and on a call") {
            hubId = launchAsAdminOnFreshHub(named: "end-call") ?? ""
            XCTAssertTrue(find("dashboard-title").waitForExistence(timeout: 15))
            callId = answerCallAsApp(callerNumber: "+15551110003", hubId: hubId)
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 20))
        }
        when("the call ends") {
            XCTAssertEqual(simulateEndCall(callId: callId), "completed", "Ended call status should be completed")
        }
        then("the call card leaves the dashboard, a Call Ended prompt takes its place, and the server no longer holds the call") {
            XCTAssertTrue(waitForCallCardToClear(), "The call card should disappear once the call has ended")
            XCTAssertTrue(find("ended-call-card").waitForExistence(timeout: 10), "My ended call should prompt for a note")
            XCTAssertFalse(serverActiveCalls(hubId: hubId).contains { $0.id == callId })
        }
    }

    func testSimulateVoicemailStatus() {
        var hubId = ""
        var callId = ""
        given("I am connected to the API with a call ringing") {
            hubId = launchAsAdminOnFreshHub(named: "voicemail") ?? ""
            XCTAssertTrue(find("dashboard-title").waitForExistence(timeout: 15))
            callId = ringCall(callerNumber: "+15551110004", hubId: hubId)
            XCTAssertTrue(find("incoming-call-card").waitForExistence(timeout: 20))
        }
        when("the caller gives up and goes to voicemail") {
            XCTAssertEqual(simulateVoicemail(callId: callId), "unanswered", "Voicemail status should be unanswered")
        }
        then("the ringing call leaves the dashboard") {
            XCTAssertTrue(waitForCallCardToClear("incoming-call-card"), "A call that went to voicemail is no longer ringing")
            XCTAssertFalse(serverActiveCalls(hubId: hubId).contains { $0.id == callId })
        }
    }

    // MARK: - Message Simulation Tests

    func testSimulateIncomingMessageAppearsInConversations() {
        var conversationId = ""
        given("I am connected to the API as a volunteer") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            XCTAssertTrue(dashboard.waitForExistence(timeout: 15))
        }
        when("an incoming message is simulated") {
            let result = simulateIncomingMessage(
                senderNumber: "+15559990001",
                body: "Help, I need assistance",
                channel: "sms"
            )
            XCTAssertFalse(result.conversationId.isEmpty, "Should return a conversationId")
            XCTAssertFalse(result.messageId.isEmpty, "Should return a messageId")
            conversationId = result.conversationId
        }
        then("the conversations tab should show the new conversation") {
            navigateToConversations()
            assertConversationRow(conversationId)
        }
    }

    func testSimulateMultipleMessagesFromSameSender() {
        var conversationId = ""
        given("I am connected to the API as a volunteer") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            XCTAssertTrue(dashboard.waitForExistence(timeout: 15))
        }
        when("multiple messages from the same sender are simulated") {
            let result1 = simulateIncomingMessage(
                senderNumber: "+15559990002",
                body: "First message",
                channel: "sms"
            )
            XCTAssertFalse(result1.conversationId.isEmpty)


            let result2 = simulateIncomingMessage(
                senderNumber: "+15559990002",
                body: "Second message",
                channel: "sms"
            )
            XCTAssertFalse(result2.conversationId.isEmpty)

            // Same sender should map to the same conversation
            XCTAssertEqual(
                result1.conversationId, result2.conversationId,
                "Messages from same sender should be in the same conversation"
            )
            conversationId = result2.conversationId
        }
        then("the conversations tab should show the conversation") {
            navigateToConversations()
            assertConversationRow(conversationId)
        }
    }

    func testSimulateWhatsAppMessage() {
        var conversationId = ""
        given("I am connected to the API as a volunteer") {
            launchWithAPI()
            let dashboard = find("dashboard-title")
            XCTAssertTrue(dashboard.waitForExistence(timeout: 15))
        }
        when("a WhatsApp message is simulated") {
            let result = simulateIncomingMessage(
                senderNumber: "+15559990003",
                body: "WhatsApp test message",
                channel: "whatsapp"
            )
            XCTAssertFalse(result.conversationId.isEmpty, "Should return a conversationId for WhatsApp")
            XCTAssertFalse(result.messageId.isEmpty, "Should return a messageId for WhatsApp")
            conversationId = result.conversationId
        }
        then("the conversations tab should show the conversation") {
            navigateToConversations()
            assertConversationRow(conversationId)
        }
    }

    // MARK: - Combined Call + Note Flow

    func testCallThenCreateNote() {
        var callId = ""
        let noteText = "Note for call \(UUID().uuidString.prefix(8))"
        given("I am connected to the API and a call has finished") {
            launchWithAPI()
            XCTAssertTrue(find("dashboard-title").waitForExistence(timeout: 15))
            callId = simulateIncomingCall(callerNumber: "+15551110005").callId
            XCTAssertFalse(callId.isEmpty, "Simulation should return a callId")
            XCTAssertEqual(simulateAnswerCall(callId: callId, pubkey: mockPubkey), "in-progress")
            XCTAssertEqual(simulateEndCall(callId: callId), "completed")
        }
        when("I write a note about that call and save it") {
            navigateToNotes()
            let createButton = anyElement(["create-note-button", "create-first-note"])
            XCTAssertTrue(createButton.waitForExistence(timeout: 10), "A create-note action should be on the Notes tab")
            createButton.tap()

            let textEditor = find("note-text-editor")
            XCTAssertTrue(textEditor.waitForExistence(timeout: 5), "The create sheet should open")
            typeText(noteText, into: textEditor)

            chooseNoteCall(callId)

            find("save-note").tap()
            XCTAssertTrue(textEditor.waitForNonExistence(timeout: 20), "The create sheet should close once the note is saved")
        }
        then("the note is listed with the text I wrote") {
            XCTAssertFalse(find("note-create-error").exists, "Saving the note should not report an error")
            XCTAssertTrue(
                app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", noteText)).firstMatch
                    .waitForExistence(timeout: 15),
                "The saved note should read back from the server in the notes list"
            )
        }
    }

    // MARK: - Helpers

    /// The conversation the server just created for a simulated message has a row in the
    /// list. An error screen, an empty list or a spinner all fail this: the list is only
    /// rendered once the conversations have loaded, and the row is only rendered if the
    /// one we created is among them.
    private func assertConversationRow(
        _ conversationId: String, file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertTrue(
            find("conversation-row-\(conversationId)").waitForExistence(timeout: 20),
            "Conversation \(conversationId) should be listed after its message was simulated",
            file: file, line: line
        )
    }

    private func anyElement(_ identifiers: [String]) -> XCUIElement {
        for id in identifiers {
            let element = find(id)
            if element.exists { return element }
        }
        return find(identifiers.first!)
    }
}
