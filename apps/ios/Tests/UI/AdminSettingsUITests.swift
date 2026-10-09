import XCTest

/// XCUITest suite for the admin settings screens added in E300:
/// Report Categories, Telephony, Call Settings, IVR Languages,
/// Transcription, Spam Settings, and System Health.
///
/// These tests verify navigation and basic UI rendering for each screen.
/// They run as a super-admin registered with the live backend (`launchAsAdminWithAPI`):
/// admin UI is gated on server-granted permissions, which an offline launch never has.
final class AdminSettingsUITests: BaseUITest {

    override func setUp() {
        super.setUp()
        launchAsAdminWithAPI()
    }

    // MARK: - Admin Settings Navigation Links

    func testAdminSettingsSectionExists() {
        navigateToAdminPanel()

        // The Settings section should have navigation links for new features
        let reportCategoriesLink = scrollToFind("admin-report-categories")
        XCTAssertTrue(
            reportCategoriesLink.exists,
            "Report Categories link should exist in admin settings section"
        )
    }

    func testAllSettingsLinksVisible() {
        navigateToAdminPanel()

        let links = [
            "admin-report-categories",
            "admin-telephony-settings",
            "admin-call-settings",
            "admin-ivr-settings",
            "admin-transcription-settings",
            "admin-spam-settings",
            "admin-system-health",
        ]

        for link in links {
            let element = scrollToFind(link)
            XCTAssertTrue(element.exists, "\(link) should be visible in admin panel")
        }
    }

    // MARK: - Report Categories

    func testReportCategoriesOpens() {
        navigateToAdminSettingsScreen("admin-report-categories")

        let found = anyElementExists([
            "report-categories-view",
            "report-categories-list",
            "categories-empty-state",
            "categories-loading",
        ])
        XCTAssertTrue(found, "Report categories view should show content, empty state, or loading")
    }

    // MARK: - Telephony Settings

    func testTelephonySettingsOpens() {
        navigateToAdminSettingsScreen("admin-telephony-settings")

        let view = find("telephony-settings-view")
        XCTAssertTrue(
            view.waitForExistence(timeout: 10),
            "Telephony settings view should appear"
        )
    }

    func testTelephonySettingsHasProviderPicker() {
        navigateToAdminSettingsScreen("admin-telephony-settings")

        let picker = find("telephony-provider-picker")
        XCTAssertTrue(
            picker.waitForExistence(timeout: 10),
            "Telephony provider picker should exist"
        )
    }

    func testTelephonySettingsHasCredentialFields() {
        navigateToAdminSettingsScreen("admin-telephony-settings")

        // `telephony-settings-view` is on the Form itself, so it exists while
        // `isLoadingTelephony` is still true and the Form is showing only a
        // ProgressView — waiting on it does NOT mean the fields have rendered.
        // A missing view must fail here, not return: an early `return` would
        // report this test as passing without checking a single field.
        let view = find("telephony-settings-view")
        XCTAssertTrue(
            view.waitForExistence(timeout: 10),
            "Telephony settings view should appear"
        )

        // `credentialsSection` renders only once loadTelephonySettings() has
        // returned, so the first field needs the same 10s budget the sibling
        // tests give the provider picker. scrollToFind's 2s default expires
        // mid-load and then swipes a still-loading Form.
        let accountSid = scrollToFind("telephony-account-sid", timeout: 10)
        XCTAssertTrue(accountSid.exists, "Account SID field should exist")

        let authToken = scrollToFind("telephony-auth-token")
        XCTAssertTrue(authToken.exists, "Auth token field should exist")

        let phoneNumber = scrollToFind("telephony-phone-number")
        XCTAssertTrue(phoneNumber.exists, "Phone number field should exist")
    }

    func testTelephonySettingsHasSaveButton() {
        navigateToAdminSettingsScreen("admin-telephony-settings")

        let saveButton = scrollToFind("telephony-save-button")
        XCTAssertTrue(saveButton.exists, "Save button should exist in telephony settings")
    }

    // MARK: - Call Settings

    func testCallSettingsOpens() {
        navigateToAdminSettingsScreen("admin-call-settings")

        let view = find("call-settings-view")
        XCTAssertTrue(
            view.waitForExistence(timeout: 10),
            "Call settings view should appear"
        )
    }

    func testCallSettingsHasSliders() {
        navigateToAdminSettingsScreen("admin-call-settings")

        let view = find("call-settings-view")
        XCTAssertTrue(view.waitForExistence(timeout: 10), "Call settings view ('call-settings-view') should appear after opening it from the admin panel")

        let ringTimeout = scrollToFind("ring-timeout-slider")
        XCTAssertTrue(ringTimeout.exists, "Ring timeout slider should exist")

        let maxDuration = scrollToFind("max-duration-slider")
        XCTAssertTrue(maxDuration.exists, "Max duration slider should exist")

        let parallelRing = scrollToFind("parallel-ring-slider")
        XCTAssertTrue(parallelRing.exists, "Parallel ring slider should exist")
    }

    func testCallSettingsHasSaveButton() {
        navigateToAdminSettingsScreen("admin-call-settings")

        let saveButton = scrollToFind("call-settings-save-button")
        XCTAssertTrue(saveButton.exists, "Save button should exist in call settings")
    }

    // MARK: - IVR Languages

    func testIvrSettingsOpens() {
        navigateToAdminSettingsScreen("admin-ivr-settings")

        let view = find("ivr-settings-view")
        XCTAssertTrue(
            view.waitForExistence(timeout: 10),
            "IVR settings view should appear"
        )
    }

    func testIvrSettingsHasSaveButton() {
        navigateToAdminSettingsScreen("admin-ivr-settings")

        let saveButton = scrollToFind("ivr-save-button")
        XCTAssertTrue(saveButton.exists, "Save button should exist in IVR settings")
    }

    // MARK: - Transcription Settings

    func testTranscriptionSettingsOpens() {
        navigateToAdminSettingsScreen("admin-transcription-settings")

        let view = find("transcription-settings-view")
        XCTAssertTrue(
            view.waitForExistence(timeout: 10),
            "Transcription settings view should appear"
        )
    }

    func testTranscriptionSettingsHasToggles() {
        navigateToAdminSettingsScreen("admin-transcription-settings")

        let view = find("transcription-settings-view")
        XCTAssertTrue(view.waitForExistence(timeout: 10), "Transcription settings view ('transcription-settings-view') should appear after opening it from the admin panel")

        let enabledToggle = scrollToFind("transcription-enabled-toggle")
        XCTAssertTrue(enabledToggle.exists, "Transcription enabled toggle should exist")

        let optOutToggle = scrollToFind("transcription-opt-out-toggle")
        XCTAssertTrue(optOutToggle.exists, "Volunteer opt-out toggle should exist")
    }

    func testTranscriptionSettingsHasSaveButton() {
        navigateToAdminSettingsScreen("admin-transcription-settings")

        let saveButton = scrollToFind("transcription-save-button")
        XCTAssertTrue(saveButton.exists, "Save button should exist in transcription settings")
    }

    // MARK: - Spam Settings

    func testSpamSettingsOpens() {
        navigateToAdminSettingsScreen("admin-spam-settings")

        let view = find("spam-settings-view")
        XCTAssertTrue(
            view.waitForExistence(timeout: 10),
            "Spam settings view should appear"
        )
    }

    func testSpamSettingsHasControls() {
        navigateToAdminSettingsScreen("admin-spam-settings")

        let view = find("spam-settings-view")
        XCTAssertTrue(view.waitForExistence(timeout: 10), "Spam settings view ('spam-settings-view') should appear after opening it from the admin panel")

        let maxCalls = scrollToFind("spam-max-calls-stepper")
        XCTAssertTrue(maxCalls.exists, "Max calls stepper should exist")

        let captchaToggle = scrollToFind("spam-captcha-toggle")
        XCTAssertTrue(captchaToggle.exists, "Voice CAPTCHA toggle should exist")

        let bypassToggle = scrollToFind("spam-bypass-toggle")
        XCTAssertTrue(bypassToggle.exists, "Known number bypass toggle should exist")
    }

    func testSpamSettingsHasSaveButton() {
        navigateToAdminSettingsScreen("admin-spam-settings")

        let saveButton = scrollToFind("spam-save-button")
        XCTAssertTrue(saveButton.exists, "Save button should exist in spam settings")
    }

    // MARK: - System Health

    func testSystemHealthOpens() {
        navigateToAdminSettingsScreen("admin-system-health")

        let found = anyElementExists([
            "system-health-view",
            "health-loading",
            "health-error-state",
        ])
        XCTAssertTrue(found, "System health view should show content, loading, or error state")
    }

    func testSystemHealthShowsCards() {
        navigateToAdminSettingsScreen("admin-system-health")

        // The ScrollView always exists; check for actual content inside it
        let errorState = find("health-error-state")
        let firstCard = find("health-card-server")

        // Wait for either health cards or error state to appear
        let loaded = firstCard.waitForExistence(timeout: 10)
            || errorState.waitForExistence(timeout: 5)

        // This class is connected to the live backend (setUp), so the error state is
        // a failed /system/health call, not an offline launch.
        XCTAssertFalse(errorState.exists, "System health should load from the connected backend, not show its error state")
        XCTAssertTrue(loaded, "System health should render its cards within 15s")

        // Health cards loaded — verify all 6 are present
        let cards = [
            "health-card-server",
            "health-card-services",
            "health-card-calls",
            "health-card-storage",
            "health-card-backup",
            "health-card-volunteers",
        ]

        for card in cards {
            let element = scrollToFind(card)
            XCTAssertTrue(element.exists, "\(card) should be visible in system health dashboard")
        }
    }

    func testSystemHealthHasRefreshButton() {
        navigateToAdminSettingsScreen("admin-system-health")

        let found = anyElementExists([
            "health-refresh-button",
            "health-retry-button",
            "health-loading",
        ])
        XCTAssertTrue(found, "System health should have refresh, retry, or loading indicator")
    }
}
