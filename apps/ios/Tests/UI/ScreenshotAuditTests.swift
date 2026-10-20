import XCTest

/// Visual audit test suite — captures screenshots of every major screen for the website
/// and presentations. Numbered methods run in alphabetical order so screenshots are
/// sequentially named.
///
/// Run a single size:
///   xcodebuild test -scheme Llamenos \
///     -destination "platform=iOS Simulator,name=iPhone 17 Pro" \
///     -only-testing:LlamenosUITests/ScreenshotAuditTests \
///     -derivedDataPath /tmp/llamenos-screenshots
///
/// Run both sizes by repeating with "iPhone 17".
final class ScreenshotAuditTests: BaseUITest {

    /// Do not auto-launch in setUp — each test launches with the appropriate state.
    override func setUp() {
        super.setUp()
        // Each test method calls its own launch (launchClean / launchAsAdmin / launchAsAdminWithAPI).
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 01 Auth / Onboarding
    // ──────────────────────────────────────────────────────────────────────────────

    /// Login screen — shown before any identity is created.
    func testScreenshot_01a_Login() {
        launchClean()
        let loginInput = find("hub-url-input")
        XCTAssertTrue(loginInput.waitForExistence(timeout: 10), "The screen should be up before it is photographed")
        screenshot("01a-login")
    }

    /// Onboarding — after tapping "Create Identity" on the login screen.
    /// V3 device key model: this lands directly on PIN set — there is no
    /// separate backup/"continue-to-pin" screen anymore (see
    /// AuthViewModel.swift's "V3 device key model" doc comment).
    func testScreenshot_01b_Onboarding() {
        launchClean()
        let createBtn = find("create-identity")
        XCTAssertTrue(createBtn.waitForExistence(timeout: 10), "createBtn should be on screen")
        createBtn.tap()
        let pinInput = find("pin-input")
        XCTAssertTrue(pinInput.waitForExistence(timeout: 5), "The screen should be up before it is photographed")
        screenshot("01b-onboarding")
    }

    /// PIN setup — shown after identity creation to set a lock PIN.
    /// PINSetView.swift uses a free-text SecureField ("pin-input"), not the
    /// digit PINPadView — that component is only used on the lock/unlock
    /// screen (PINUnlockView.swift).
    func testScreenshot_01c_PINSet() {
        launchClean()
        let createBtn = find("create-identity")
        XCTAssertTrue(createBtn.waitForExistence(timeout: 10), "createBtn should be on screen")
        createBtn.tap()
        let pinInput = find("pin-input")
        XCTAssertTrue(pinInput.waitForExistence(timeout: 5), "The screen should be up before it is photographed")
        screenshot("01c-pin-set")
    }

    /// PIN unlock — shown when the app is locked and the user must enter their PIN.
    func testScreenshot_01d_PINUnlock() {
        // Launch authenticated so there IS an identity, then lock immediately.
        launchAuthenticated()
        let dashboard = find("dashboard-title")
        XCTAssertTrue(dashboard.waitForExistence(timeout: 10), "dashboard should be on screen")
        // Lock the app via the lock button on the dashboard.
        let lockBtn = find("lock-app")
        if lockBtn.waitForExistence(timeout: 3) {
            lockBtn.tap()
        }
        let pinPad = find("pin-pad")
        XCTAssertTrue(pinPad.waitForExistence(timeout: 5), "The screen should be up before it is photographed")
        screenshot("01d-pin-unlock")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 02 Dashboard
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_02a_Dashboard() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        XCTAssertTrue(dashboard.waitForExistence(timeout: 10), "The screen should be up before it is photographed")
        screenshot("02a-dashboard")
    }

    /// Dashboard with an active call card (requires backend simulation).
    func testScreenshot_02b_DashboardActiveCall() {
        XCTAssertFalse(testHubId.isEmpty, "The class hub should have been created")
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        XCTAssertTrue(dashboard.waitForExistence(timeout: 15), "dashboard should be on screen")
        XCTAssertFalse(simulateIncomingCall(hubId: testHubId).callId.isEmpty, "The simulated call should be created")
        let callCard = find("active-call-card")
        XCTAssertTrue(callCard.waitForExistence(timeout: 15), "The call card should be on screen before it is photographed")
        screenshot("02b-dashboard-active-call")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 03 Active Call UI
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_03_ActiveCall() {
        XCTAssertFalse(testHubId.isEmpty, "The class hub should have been created")
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        XCTAssertTrue(dashboard.waitForExistence(timeout: 15), "dashboard should be on screen")
        XCTAssertFalse(simulateIncomingCall(hubId: testHubId).callId.isEmpty, "The simulated call should be created")
        let callCard = find("active-call-card")
        XCTAssertTrue(callCard.waitForExistence(timeout: 15), "The call card should be on screen")
        screenshot("03-active-call")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 04 Notes
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_04a_NotesList() {
        launchAsAdminWithAPI()
        navigateToNotes()
        XCTAssertTrue(anyElementExists(["notes-list", "notes-empty-state"], timeout: 10), "The screen should have loaded before it is photographed")
        screenshot("04a-notes-list")
    }

    /// Notes list with data — requires backend.
    func testScreenshot_04b_NotesListWithData() {
        XCTAssertFalse(testHubId.isEmpty, "The class hub should have been created")
        launchAsAdminWithAPI()
        navigateToNotes()
        XCTAssertTrue(anyElementExists(["notes-list", "notes-empty-state"], timeout: 12), "The screen should have loaded before it is photographed")
        screenshot("04b-notes-list-data")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 05 Cases
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_05a_CasesList() {
        launchAsAdminWithAPI()
        navigateToCases()
        XCTAssertTrue(anyElementExists(["case-list", "case-empty-state", "cms-not-enabled"], timeout: 10), "The screen should have loaded before it is photographed")
        screenshot("05a-cases-list")
    }

    func testScreenshot_05b_CasesListWithData() {
        XCTAssertFalse(testHubId.isEmpty, "The class hub should have been created")
        launchAsAdminWithAPI()
        navigateToCases()
        XCTAssertTrue(anyElementExists(["case-list", "case-empty-state", "cms-not-enabled"], timeout: 12), "The screen should have loaded before it is photographed")
        screenshot("05b-cases-list-data")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 06 Conversations
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_06a_ConversationsList() {
        launchAsAdminWithAPI()
        navigateToConversations()
        XCTAssertTrue(anyElementExists(["conversations-list", "conversations-empty-state"], timeout: 10), "The screen should have loaded before it is photographed")
        screenshot("06a-conversations-list")
    }

    func testScreenshot_06b_ConversationsWithData() {
        XCTAssertFalse(testHubId.isEmpty, "The class hub should have been created")
        launchAsAdminWithAPI()
        simulateIncomingMessage(body: "Hi, I need some help please.")
        navigateToConversations()
        XCTAssertTrue(anyElementExists(["conversations-list", "conversations-empty-state"], timeout: 12), "The screen should have loaded before it is photographed")
        screenshot("06b-conversations-data")
    }

    func testScreenshot_06c_ConversationDetail() {
        XCTAssertFalse(testHubId.isEmpty, "The class hub should have been created")
        launchAsAdminWithAPI()
        let (convId, _) = simulateIncomingMessage(body: "Hello, I need help.")
        XCTAssertFalse(convId.isEmpty, "The simulated message should have created a conversation")
        navigateToConversations()
        let row = find("conversation-row-\(convId)")
        XCTAssertTrue(row.waitForExistence(timeout: 10), "The simulated conversation should be listed")
        XCTAssertTrue(row.isHittable, "The conversation row should be tappable")
        row.tap()
        XCTAssertTrue(anyElementExists(["conversation-detail-view", "messages-list", "messages-empty-state"], timeout: 8), "The screen should have loaded before it is photographed")
        screenshot("06c-conversation-detail")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 07 Shifts
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_07_Shifts() {
        launchAsAdminWithAPI()
        navigateToShifts()
        XCTAssertTrue(anyElementExists(["shifts-empty-state", "clock-in-button"], timeout: 10), "The screen should have loaded before it is photographed")
        screenshot("07-shifts")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 08 Reports (quick action from Dashboard)
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_08a_Reports() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        XCTAssertTrue(dashboard.waitForExistence(timeout: 10), "dashboard should be on screen")
        let reportsBtn = find("dashboard-reports-action")
        XCTAssertTrue(reportsBtn.waitForExistence(timeout: 5), "reportsBtn should be on screen")
        reportsBtn.tap()
        XCTAssertTrue(anyElementExists(["reports-list", "reports-empty-state"], timeout: 10), "The screen should have loaded before it is photographed")
        screenshot("08a-reports-list")
    }

    func testScreenshot_08b_ReportsWithData() {
        XCTAssertFalse(testHubId.isEmpty, "The class hub should have been created")
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        XCTAssertTrue(dashboard.waitForExistence(timeout: 15), "dashboard should be on screen")
        let reportsBtn = find("dashboard-reports-action")
        XCTAssertTrue(reportsBtn.waitForExistence(timeout: 5), "reportsBtn should be on screen")
        reportsBtn.tap()
        XCTAssertTrue(anyElementExists(["reports-list", "reports-empty-state"], timeout: 12), "The screen should have loaded before it is photographed")
        screenshot("08b-reports-data")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 09 Contacts (quick action from Dashboard)
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_09_Contacts() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        XCTAssertTrue(dashboard.waitForExistence(timeout: 10), "dashboard should be on screen")
        let contactsBtn = find("dashboard-contacts-action")
        XCTAssertTrue(contactsBtn.waitForExistence(timeout: 5), "contactsBtn should be on screen")
        contactsBtn.tap()
        XCTAssertTrue(anyElementExists(["contacts-list", "contacts-empty-state"], timeout: 10), "The screen should have loaded before it is photographed")
        screenshot("09-contacts-list")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 10 Blasts (quick action from Dashboard)
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_10_Blasts() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        XCTAssertTrue(dashboard.waitForExistence(timeout: 10), "dashboard should be on screen")
        let blastsBtn = find("dashboard-blasts-action")
        XCTAssertTrue(blastsBtn.waitForExistence(timeout: 5), "blastsBtn should be on screen")
        blastsBtn.tap()
        XCTAssertTrue(anyElementExists(["blasts-list", "blasts-empty-state"], timeout: 10), "The screen should have loaded before it is photographed")
        screenshot("10-blasts-list")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 11 Triage (quick action from Dashboard)
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_11_Triage() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        XCTAssertTrue(dashboard.waitForExistence(timeout: 10), "dashboard should be on screen")
        let triageBtn = find("dashboard-triage-action")
        XCTAssertTrue(triageBtn.waitForExistence(timeout: 5), "triageBtn should be on screen")
        triageBtn.tap()
        XCTAssertTrue(anyElementExists(["triage-list", "triage-empty-state"], timeout: 10), "The screen should have loaded before it is photographed")
        screenshot("11-triage-list")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 12 Call History (quick action from Dashboard)
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_12_CallHistory() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        XCTAssertTrue(dashboard.waitForExistence(timeout: 10), "dashboard should be on screen")
        let historyBtn = find("dashboard-call-history-action")
        XCTAssertTrue(historyBtn.waitForExistence(timeout: 5), "historyBtn should be on screen")
        historyBtn.tap()
        XCTAssertTrue(anyElementExists(["call-history-list", "call-history-empty"], timeout: 10), "The screen should have loaded before it is photographed")
        screenshot("12-call-history")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 13 Help (quick action from Dashboard)
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_13_Help() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        XCTAssertTrue(dashboard.waitForExistence(timeout: 10), "dashboard should be on screen")
        let helpBtn = find("dashboard-help-action")
        XCTAssertTrue(helpBtn.waitForExistence(timeout: 5), "helpBtn should be on screen")
        helpBtn.tap()
        let helpScreen = find("help-screen")
        XCTAssertTrue(helpScreen.waitForExistence(timeout: 5), "The screen should be up before it is photographed")
        screenshot("13a-help")
        app.swipeUp()
        screenshot("13b-help-scrolled")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 14 Settings
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_14a_Settings() {
        launchAsAdminWithAPI()
        navigateToSettings()
        XCTAssertTrue(find("settings-account-link").waitForExistence(timeout: 8), "The screen should be up before it is photographed")
        screenshot("14a-settings")
        app.swipeUp()
        screenshot("14b-settings-scrolled")
    }

    func testScreenshot_14c_AccountSettings() {
        launchAsAdminWithAPI()
        navigateToAccountSettings()
        XCTAssertTrue(anyElementExists(["settings-signing-pubkey", "settings-device-id", "copy-signing-pubkey"], timeout: 8), "The screen should have loaded before it is photographed")
        screenshot("14c-account-settings")
    }

    func testScreenshot_14d_Preferences() {
        launchAsAdminWithAPI()
        navigateToPreferencesSettings()
        XCTAssertTrue(anyElementExists(["settings-call-sounds", "settings-language-picker", "settings-auto-lock-picker"], timeout: 8), "The screen should have loaded before it is photographed")
        screenshot("14d-preferences")
    }

    func testScreenshot_14e_TranscriptionSettings() {
        launchAsAdminWithAPI()
        navigateToSettings()
        let transcriptionLink = scrollToFind("settings-transcription-link", maxSwipes: 5, timeout: 5)
        XCTAssertTrue(transcriptionLink.exists && transcriptionLink.isHittable, "transcriptionLink should be reachable")
        transcriptionLink.tap()
        XCTAssertTrue(anyElementExists(["transcription-enable-toggle", "transcription-language-picker"], timeout: 5), "The screen should have loaded before it is photographed")
        screenshot("14e-transcription-settings")
    }

    func testScreenshot_14f_Diagnostics() {
        launchAsAdminWithAPI()
        navigateToSettings()
        let diagLink = scrollToFind("settings-diagnostics-link", maxSwipes: 5, timeout: 5)
        XCTAssertTrue(diagLink.exists && diagLink.isHittable, "diagLink should be reachable")
        diagLink.tap()
        XCTAssertTrue(anyElementExists(["crash-reporting-toggle", "send-crash-reports"], timeout: 5), "The screen should have loaded before it is photographed")
        screenshot("14f-diagnostics")
    }

    func testScreenshot_14g_HubManagement() {
        launchAsAdminWithAPI()
        navigateToSettings()
        let hubsLink = scrollToFind("settings-hubs-link", maxSwipes: 5, timeout: 5)
        XCTAssertTrue(hubsLink.exists && hubsLink.isHittable, "hubsLink should be reachable")
        hubsLink.tap()
        XCTAssertTrue(anyElementExists(["hubs-list"], timeout: 8), "The screen should have loaded before it is photographed")
        screenshot("14g-hub-management")
    }

    func testScreenshot_14h_PanicWipe() {
        launchAsAdminWithAPI()
        navigateToSettings()
        let panicLink = scrollToFind("settings-panic-wipe", maxSwipes: 5, timeout: 5)
        XCTAssertTrue(panicLink.exists && panicLink.isHittable, "panicLink should be reachable")
        panicLink.tap()
        // Sheet appears — capture it
        XCTAssertTrue(find("confirm-panic-wipe").waitForExistence(timeout: 5), "The panic wipe screen should be up before it is photographed")
        screenshot("14h-panic-wipe")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 15 Admin Panel
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_15a_AdminPanel() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        XCTAssertTrue(find("admin-tab-view").waitForExistence(timeout: 8), "The screen should be up before it is photographed")
        screenshot("15a-admin-panel")
        app.swipeUp()
        screenshot("15b-admin-panel-scrolled")
    }

    func testScreenshot_15c_AdminVolunteers() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-volunteers", maxSwipes: 3, timeout: 5)
        XCTAssertTrue(link.exists && link.isHittable, "link should be reachable")
        link.tap()
        XCTAssertTrue(anyElementExists(["volunteers-list", "volunteers-empty-state"], timeout: 8), "The screen should have loaded before it is photographed")
        screenshot("15c-admin-volunteers")
    }

    func testScreenshot_15d_AdminBanList() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-bans", maxSwipes: 3, timeout: 5)
        XCTAssertTrue(link.exists && link.isHittable, "link should be reachable")
        link.tap()
        XCTAssertTrue(anyElementExists(["ban-list", "bans-empty-state"], timeout: 10), "The screen should have loaded before it is photographed (15d-admin-ban-list)")
        screenshot("15d-admin-ban-list")
    }

    func testScreenshot_15e_AdminAuditLog() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-audit-log", maxSwipes: 3, timeout: 5)
        XCTAssertTrue(link.exists && link.isHittable, "link should be reachable")
        link.tap()
        XCTAssertTrue(anyElementExists(["audit-log-list", "audit-empty-state"], timeout: 10), "The screen should have loaded before it is photographed (15e-admin-audit-log)")
        screenshot("15e-admin-audit-log")
    }

    func testScreenshot_15f_AdminInvites() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-invites", maxSwipes: 3, timeout: 5)
        XCTAssertTrue(link.exists && link.isHittable, "link should be reachable")
        link.tap()
        XCTAssertTrue(anyElementExists(["invites-list", "invites-empty-state"], timeout: 10), "The screen should have loaded before it is photographed (15f-admin-invites)")
        screenshot("15f-admin-invites")
    }

    func testScreenshot_15g_AdminCustomFields() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-custom-fields", maxSwipes: 3, timeout: 5)
        XCTAssertTrue(link.exists && link.isHittable, "link should be reachable")
        link.tap()
        XCTAssertTrue(anyElementExists(["custom-fields-list", "custom-fields-empty-state"], timeout: 8), "The screen should have loaded before it is photographed")
        screenshot("15g-admin-custom-fields")
    }

    func testScreenshot_15h_AdminSchemaBrowser() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-schema-browser", maxSwipes: 3, timeout: 5)
        XCTAssertTrue(link.exists && link.isHittable, "link should be reachable")
        link.tap()
        XCTAssertTrue(anyElementExists(["schema-browser-list", "schema-browser-empty"], timeout: 10), "The screen should have loaded before it is photographed (15h-admin-schema-browser)")
        screenshot("15h-admin-schema-browser")
    }

    func testScreenshot_15i_AdminTelephony() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-telephony-settings", maxSwipes: 5, timeout: 5)
        XCTAssertTrue(link.exists && link.isHittable, "link should be reachable")
        link.tap()
        XCTAssertTrue(anyElementExists(["telephony-settings-view", "telephony-provider-picker"], timeout: 8), "The screen should have loaded before it is photographed")
        screenshot("15i-admin-telephony")
    }

    func testScreenshot_15j_AdminSpam() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-spam-settings", maxSwipes: 5, timeout: 5)
        XCTAssertTrue(link.exists && link.isHittable, "link should be reachable")
        link.tap()
        XCTAssertTrue(find("spam-settings-view").waitForExistence(timeout: 8), "The screen should be up before it is photographed")
        screenshot("15j-admin-spam")
    }

    func testScreenshot_15k_AdminSystemHealth() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-system-health", maxSwipes: 5, timeout: 5)
        XCTAssertTrue(link.exists && link.isHittable, "link should be reachable")
        link.tap()
        XCTAssertTrue(anyElementExists(["system-health-view", "health-error-state"], timeout: 10), "The screen should have loaded before it is photographed")
        screenshot("15k-admin-system-health")
    }

    func testScreenshot_15l_AdminIVR() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-ivr-settings", maxSwipes: 5, timeout: 5)
        XCTAssertTrue(link.exists && link.isHittable, "link should be reachable")
        link.tap()
        XCTAssertTrue(anyElementExists(["ivr-settings-view", "ivr-save-button"], timeout: 8), "The screen should have loaded before it is photographed")
        screenshot("15l-admin-ivr")
    }

    func testScreenshot_15m_AdminReportCategories() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-report-categories", maxSwipes: 5, timeout: 5)
        XCTAssertTrue(link.exists && link.isHittable, "link should be reachable")
        link.tap()
        XCTAssertTrue(anyElementExists(["report-categories-list", "categories-empty-state"], timeout: 10), "The screen should have loaded before it is photographed (15m-admin-report-categories)")
        screenshot("15m-admin-report-categories")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – Screenshot Helper
    // ──────────────────────────────────────────────────────────────────────────────

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
