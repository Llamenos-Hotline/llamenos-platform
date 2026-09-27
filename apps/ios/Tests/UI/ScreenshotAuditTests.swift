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

    /// Screenshot tests default to the Linux dev machine when TEST_HUB_URL is not set,
    /// since XCUITest runners don't inherit host environment variables.
    override var testHubURL: String {
        ProcessInfo.processInfo.environment["TEST_HUB_URL"]
            ?? "http://192.168.50.95:3000"
    }

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
        _ = loginInput.waitForExistence(timeout: 10)
        screenshot("01a-login")
    }

    /// Onboarding — after tapping "Create Identity" on the login screen.
    /// V3 device key model: this lands directly on PIN set — there is no
    /// separate backup/"continue-to-pin" screen anymore (see
    /// AuthViewModel.swift's "V3 device key model" doc comment).
    func testScreenshot_01b_Onboarding() {
        launchClean()
        let createBtn = find("create-identity")
        guard createBtn.waitForExistence(timeout: 10) else { return }
        createBtn.tap()
        let pinInput = find("pin-input")
        _ = pinInput.waitForExistence(timeout: 5)
        screenshot("01b-onboarding")
    }

    /// PIN setup — shown after identity creation to set a lock PIN.
    /// PINSetView.swift uses a free-text SecureField ("pin-input"), not the
    /// digit PINPadView — that component is only used on the lock/unlock
    /// screen (PINUnlockView.swift).
    func testScreenshot_01c_PINSet() {
        launchClean()
        let createBtn = find("create-identity")
        guard createBtn.waitForExistence(timeout: 10) else { return }
        createBtn.tap()
        let pinInput = find("pin-input")
        _ = pinInput.waitForExistence(timeout: 5)
        screenshot("01c-pin-set")
    }

    /// PIN unlock — shown when the app is locked and the user must enter their PIN.
    func testScreenshot_01d_PINUnlock() {
        // Launch authenticated so there IS an identity, then lock immediately.
        launchAuthenticated()
        let dashboard = find("dashboard-title")
        guard dashboard.waitForExistence(timeout: 10) else { return }
        // Lock the app via the lock button on the dashboard.
        let lockBtn = find("lock-app")
        if lockBtn.waitForExistence(timeout: 3) {
            lockBtn.tap()
        }
        let pinPad = find("pin-pad")
        _ = pinPad.waitForExistence(timeout: 5)
        screenshot("01d-pin-unlock")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 02 Dashboard
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_02a_Dashboard() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        _ = dashboard.waitForExistence(timeout: 10)
        screenshot("02a-dashboard")
    }

    /// Dashboard with an active call card (requires backend simulation).
    func testScreenshot_02b_DashboardActiveCall() {
        guard !testHubId.isEmpty else { return }
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        guard dashboard.waitForExistence(timeout: 15) else { return }
        simulateIncomingCall()
        let callCard = find("active-call-card")
        _ = callCard.waitForExistence(timeout: 8)
        screenshot("02b-dashboard-active-call")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 03 Active Call UI
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_03_ActiveCall() {
        guard !testHubId.isEmpty else { return }
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        guard dashboard.waitForExistence(timeout: 15) else { return }
        simulateIncomingCall()
        let callCard = find("active-call-card")
        guard callCard.waitForExistence(timeout: 8) else { return }
        screenshot("03-active-call")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 04 Notes
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_04a_NotesList() {
        launchAsAdminWithAPI()
        navigateToNotes()
        let list = find("notes-list")
        let empty = find("notes-empty-state")
        _ = anyElementExists(["notes-list", "notes-empty-state", "notes-loading"], timeout: 10)
        screenshot("04a-notes-list")
    }

    /// Notes list with data — requires backend.
    func testScreenshot_04b_NotesListWithData() {
        guard !testHubId.isEmpty else { return }
        launchAsAdminWithAPI()
        navigateToNotes()
        _ = anyElementExists(["notes-list", "notes-empty-state"], timeout: 12)
        screenshot("04b-notes-list-data")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 05 Cases
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_05a_CasesList() {
        launchAsAdminWithAPI()
        navigateToCases()
        _ = anyElementExists(["case-list", "case-empty-state", "case-loading", "cms-not-enabled"], timeout: 10)
        screenshot("05a-cases-list")
    }

    func testScreenshot_05b_CasesListWithData() {
        guard !testHubId.isEmpty else { return }
        launchAsAdminWithAPI()
        navigateToCases()
        _ = anyElementExists(["case-list", "case-empty-state", "cms-not-enabled"], timeout: 12)
        screenshot("05b-cases-list-data")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 06 Conversations
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_06a_ConversationsList() {
        launchAsAdminWithAPI()
        navigateToConversations()
        _ = anyElementExists(["conversations-list", "conversations-empty-state", "conversations-loading"], timeout: 10)
        screenshot("06a-conversations-list")
    }

    func testScreenshot_06b_ConversationsWithData() {
        guard !testHubId.isEmpty else { return }
        launchAsAdminWithAPI()
        simulateIncomingMessage(body: "Hi, I need some help please.")
        navigateToConversations()
        _ = anyElementExists(["conversations-list", "conversations-empty-state"], timeout: 12)
        screenshot("06b-conversations-data")
    }

    func testScreenshot_06c_ConversationDetail() {
        guard !testHubId.isEmpty else { return }
        launchAsAdminWithAPI()
        let (convId, _) = simulateIncomingMessage(body: "Hello, I need help.")
        guard !convId.isEmpty else { return }
        navigateToConversations()
        let row = find("conversation-row-\(convId)")
        if row.waitForExistence(timeout: 10) && row.isHittable {
            row.tap()
        } else {
            // Tap first row in the list as fallback
            let list = find("conversations-list")
            if list.waitForExistence(timeout: 5) {
                app.tables.cells.firstMatch.tap()
            }
        }
        _ = anyElementExists(["conversation-detail-view", "messages-list", "messages-empty-state"], timeout: 8)
        screenshot("06c-conversation-detail")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 07 Shifts
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_07_Shifts() {
        launchAsAdminWithAPI()
        navigateToShifts()
        _ = anyElementExists(["shifts-empty-state", "clock-in-button", "shifts-loading"], timeout: 10)
        screenshot("07-shifts")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 08 Reports (quick action from Dashboard)
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_08a_Reports() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        guard dashboard.waitForExistence(timeout: 10) else { return }
        let reportsBtn = find("dashboard-reports-action")
        guard reportsBtn.waitForExistence(timeout: 5) else { return }
        reportsBtn.tap()
        _ = anyElementExists(["reports-list", "reports-empty-state", "reports-loading"], timeout: 10)
        screenshot("08a-reports-list")
    }

    func testScreenshot_08b_ReportsWithData() {
        guard !testHubId.isEmpty else { return }
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        guard dashboard.waitForExistence(timeout: 15) else { return }
        let reportsBtn = find("dashboard-reports-action")
        guard reportsBtn.waitForExistence(timeout: 5) else { return }
        reportsBtn.tap()
        _ = anyElementExists(["reports-list", "reports-empty-state"], timeout: 12)
        screenshot("08b-reports-data")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 09 Contacts (quick action from Dashboard)
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_09_Contacts() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        guard dashboard.waitForExistence(timeout: 10) else { return }
        let contactsBtn = find("dashboard-contacts-action")
        guard contactsBtn.waitForExistence(timeout: 5) else { return }
        contactsBtn.tap()
        _ = anyElementExists(["contacts-list", "contacts-empty-state", "contacts-loading"], timeout: 10)
        screenshot("09-contacts-list")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 10 Blasts (quick action from Dashboard)
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_10_Blasts() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        guard dashboard.waitForExistence(timeout: 10) else { return }
        let blastsBtn = find("dashboard-blasts-action")
        guard blastsBtn.waitForExistence(timeout: 5) else { return }
        blastsBtn.tap()
        _ = anyElementExists(["blasts-list", "blasts-empty-state", "blasts-loading"], timeout: 10)
        screenshot("10-blasts-list")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 11 Triage (quick action from Dashboard)
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_11_Triage() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        guard dashboard.waitForExistence(timeout: 10) else { return }
        let triageBtn = find("dashboard-triage-action")
        guard triageBtn.waitForExistence(timeout: 5) else { return }
        triageBtn.tap()
        _ = anyElementExists(["triage-list", "triage-empty-state", "triage-loading"], timeout: 10)
        screenshot("11-triage-list")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 12 Call History (quick action from Dashboard)
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_12_CallHistory() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        guard dashboard.waitForExistence(timeout: 10) else { return }
        let historyBtn = find("dashboard-call-history-action")
        guard historyBtn.waitForExistence(timeout: 5) else { return }
        historyBtn.tap()
        _ = anyElementExists(["call-history-list", "call-history-empty", "call-history-loading"], timeout: 10)
        screenshot("12-call-history")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 13 Help (quick action from Dashboard)
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_13_Help() {
        launchAsAdminWithAPI()
        let dashboard = find("dashboard-title")
        guard dashboard.waitForExistence(timeout: 10) else { return }
        let helpBtn = find("dashboard-help-action")
        guard helpBtn.waitForExistence(timeout: 5) else { return }
        helpBtn.tap()
        let helpScreen = find("help-screen")
        _ = helpScreen.waitForExistence(timeout: 5)
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
        _ = find("settings-account-link").waitForExistence(timeout: 8)
        screenshot("14a-settings")
        app.swipeUp()
        screenshot("14b-settings-scrolled")
    }

    func testScreenshot_14c_AccountSettings() {
        launchAsAdminWithAPI()
        navigateToAccountSettings()
        _ = anyElementExists(["settings-signing-pubkey", "settings-device-id", "copy-signing-pubkey"], timeout: 8)
        screenshot("14c-account-settings")
    }

    func testScreenshot_14d_Preferences() {
        launchAsAdminWithAPI()
        navigateToPreferencesSettings()
        _ = anyElementExists(["settings-call-sounds", "settings-language-picker", "settings-auto-lock-picker"], timeout: 8)
        screenshot("14d-preferences")
    }

    func testScreenshot_14e_TranscriptionSettings() {
        launchAsAdminWithAPI()
        navigateToSettings()
        let transcriptionLink = scrollToFind("settings-transcription-link", maxSwipes: 5, timeout: 5)
        guard transcriptionLink.exists && transcriptionLink.isHittable else { return }
        transcriptionLink.tap()
        _ = anyElementExists(["transcription-enable-toggle", "transcription-language-picker"], timeout: 5)
        screenshot("14e-transcription-settings")
    }

    func testScreenshot_14f_Diagnostics() {
        launchAsAdminWithAPI()
        navigateToSettings()
        let diagLink = scrollToFind("settings-diagnostics-link", maxSwipes: 5, timeout: 5)
        guard diagLink.exists && diagLink.isHittable else { return }
        diagLink.tap()
        _ = anyElementExists(["crash-reporting-toggle", "send-crash-reports"], timeout: 5)
        screenshot("14f-diagnostics")
    }

    func testScreenshot_14g_HubManagement() {
        launchAsAdminWithAPI()
        navigateToSettings()
        let hubsLink = scrollToFind("settings-hubs-link", maxSwipes: 5, timeout: 5)
        guard hubsLink.exists && hubsLink.isHittable else { return }
        hubsLink.tap()
        _ = anyElementExists(["hubs-list", "hubs-loading"], timeout: 8)
        screenshot("14g-hub-management")
    }

    func testScreenshot_14h_PanicWipe() {
        launchAsAdminWithAPI()
        navigateToSettings()
        let panicLink = scrollToFind("settings-panic-wipe", maxSwipes: 5, timeout: 5)
        guard panicLink.exists && panicLink.isHittable else { return }
        panicLink.tap()
        // Sheet appears — capture it
        _ = find("pin-pad").waitForExistence(timeout: 3)
        screenshot("14h-panic-wipe")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 15 Admin Panel
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_15a_AdminPanel() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        _ = find("admin-tab-view").waitForExistence(timeout: 8)
        screenshot("15a-admin-panel")
        app.swipeUp()
        screenshot("15b-admin-panel-scrolled")
    }

    func testScreenshot_15c_AdminVolunteers() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-volunteers", maxSwipes: 3, timeout: 5)
        guard link.exists && link.isHittable else { return }
        link.tap()
        _ = anyElementExists(["volunteers-list", "volunteers-empty-state"], timeout: 8)
        screenshot("15c-admin-volunteers")
    }

    func testScreenshot_15d_AdminBanList() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-bans", maxSwipes: 3, timeout: 5)
        guard link.exists && link.isHittable else { return }
        link.tap()
        sleep(2)
        screenshot("15d-admin-ban-list")
    }

    func testScreenshot_15e_AdminAuditLog() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-audit-log", maxSwipes: 3, timeout: 5)
        guard link.exists && link.isHittable else { return }
        link.tap()
        sleep(2)
        screenshot("15e-admin-audit-log")
    }

    func testScreenshot_15f_AdminInvites() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-invites", maxSwipes: 3, timeout: 5)
        guard link.exists && link.isHittable else { return }
        link.tap()
        sleep(2)
        screenshot("15f-admin-invites")
    }

    func testScreenshot_15g_AdminCustomFields() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-custom-fields", maxSwipes: 3, timeout: 5)
        guard link.exists && link.isHittable else { return }
        link.tap()
        _ = anyElementExists(["custom-fields-list", "custom-fields-empty-state", "custom-fields-loading"], timeout: 8)
        screenshot("15g-admin-custom-fields")
    }

    func testScreenshot_15h_AdminSchemaBrowser() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-schema-browser", maxSwipes: 3, timeout: 5)
        guard link.exists && link.isHittable else { return }
        link.tap()
        sleep(2)
        screenshot("15h-admin-schema-browser")
    }

    func testScreenshot_15i_AdminTelephony() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-telephony-settings", maxSwipes: 5, timeout: 5)
        guard link.exists && link.isHittable else { return }
        link.tap()
        _ = anyElementExists(["telephony-settings-view", "telephony-provider-picker"], timeout: 8)
        screenshot("15i-admin-telephony")
    }

    func testScreenshot_15j_AdminSpam() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-spam-settings", maxSwipes: 5, timeout: 5)
        guard link.exists && link.isHittable else { return }
        link.tap()
        _ = find("spam-settings-view").waitForExistence(timeout: 8)
        screenshot("15j-admin-spam")
    }

    func testScreenshot_15k_AdminSystemHealth() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-system-health", maxSwipes: 5, timeout: 5)
        guard link.exists && link.isHittable else { return }
        link.tap()
        _ = anyElementExists(["system-health-view", "health-loading", "health-error-state"], timeout: 10)
        screenshot("15k-admin-system-health")
    }

    func testScreenshot_15l_AdminIVR() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-ivr-settings", maxSwipes: 5, timeout: 5)
        guard link.exists && link.isHittable else { return }
        link.tap()
        _ = anyElementExists(["ivr-settings-view", "ivr-save-button"], timeout: 8)
        screenshot("15l-admin-ivr")
    }

    func testScreenshot_15m_AdminReportCategories() {
        launchAsAdminWithAPI()
        navigateToAdminPanel()
        let link = scrollToFind("admin-report-categories", maxSwipes: 5, timeout: 5)
        guard link.exists && link.isHittable else { return }
        link.tap()
        sleep(2)
        screenshot("15m-admin-report-categories")
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // MARK: – 16 Device Linking
    // ──────────────────────────────────────────────────────────────────────────────

    func testScreenshot_16_DeviceLink() {
        launchAsAdminWithAPI()
        navigateToAccountSettings()
        let linkBtn = scrollToFind("settings-link-device", maxSwipes: 5, timeout: 5)
        guard linkBtn.exists && linkBtn.isHittable else { return }
        linkBtn.tap()
        _ = anyElementExists([
            "device-link-view", "qr-scanner", "device-link-connecting", "device-link-error"
        ], timeout: 8)
        screenshot("16-device-link")
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
