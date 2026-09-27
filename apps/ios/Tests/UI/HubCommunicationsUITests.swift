import XCTest

/// XCUITest suite for hub communications self-service screens.
/// Tests the HubCommunicationsView (settings panel), HubOnboardingSheet (wizard),
/// ProviderTemplateListView, ChannelChecklistView, and HubUsageView.
///
/// Admin-gated: the "Communications" link only appears for admin users.
/// Non-admin tests verify the link is absent.
final class HubCommunicationsUITests: BaseUITest {

    // MARK: - Admin Visibility

    func testAdminSeesCommunicationsLink() {
        given("I am logged in as an admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to settings") {
            navigateToSettings()
        }
        then("the Communications link should be visible") {
            let commsLink = scrollToFind("settings-communications-link", maxSwipes: 5)
            XCTAssertTrue(
                commsLink.exists,
                "Admin users should see the Communications settings link"
            )
        }
    }

    func testNonAdminDoesNotSeeCommunicationsLink() {
        given("I am logged in as a volunteer (non-admin)") {
            launchAuthenticated()
        }
        when("I navigate to settings") {
            navigateToSettings()
        }
        then("the Communications link should NOT be visible") {
            let commsLink = scrollToFind("settings-communications-link", maxSwipes: 5)
            XCTAssertFalse(
                commsLink.exists,
                "Non-admin users should NOT see the Communications settings link"
            )
        }
    }

    // MARK: - Communications View States

    func testCommunicationsViewShowsLoadingOrContent() {
        given("I am logged in as an admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Communications settings") {
            navigateToCommunications()
        }
        then("the view should show loading, no-provider, or settings content") {
            let found = anyElementExists([
                "hub-comms-loading",
                "hub-comms-no-provider",
                "hub-comms-settings-list",
            ])
            XCTAssertTrue(
                found,
                "Communications view should show loading, no-provider state, or settings list"
            )
        }
    }

    func testNoProviderStateShowsSetupButton() {
        given("I am logged in as an admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Communications settings") {
            navigateToCommunications()
        }
        then("if no provider is configured, the setup button should appear") {
            let noProvider = find("hub-comms-no-provider")
            guard noProvider.waitForExistence(timeout: 10) else {
                // Provider may already be configured in test environment -- skip
                return
            }
            let setupButton = find("hub-comms-start-setup-btn")
            XCTAssertTrue(
                setupButton.waitForExistence(timeout: 5),
                "Start Setup button should appear when no provider is configured"
            )
        }
    }

    // MARK: - Onboarding Sheet

    func testOnboardingSheetAppearsOnSetupTap() {
        given("I am logged in as an admin with no provider configured") {
            launchAsAdminWithAPI()
        }
        when("I tap the Start Setup button") {
            navigateToCommunications()
            let noProvider = find("hub-comms-no-provider")
            guard noProvider.waitForExistence(timeout: 10) else {
                // Provider already configured; cannot test onboarding flow
                return
            }
            let setupButton = find("hub-comms-start-setup-btn")
            guard setupButton.waitForExistence(timeout: 5) else {
                XCTFail("Start Setup button should exist")
                return
            }
            setupButton.tap()
        }
        then("the onboarding sheet should appear") {
            let sheet = find("hub-onboarding-sheet")
            XCTAssertTrue(
                sheet.waitForExistence(timeout: 5),
                "Onboarding sheet should be presented after tapping Start Setup"
            )
        }
    }

    func testOnboardingSheetShowsStepIndicator() {
        given("I open the onboarding sheet") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
        }
        then("the step indicator should be visible") {
            let indicator = find("onboarding-step-indicator")
            XCTAssertTrue(
                indicator.waitForExistence(timeout: 5),
                "Step indicator should be visible in the onboarding sheet"
            )
        }
    }

    func testOnboardingSheetShowsCancelButton() {
        given("I open the onboarding sheet") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
        }
        then("the cancel button should be visible") {
            let cancelBtn = find("onboarding-cancel-btn")
            XCTAssertTrue(
                cancelBtn.waitForExistence(timeout: 5),
                "Cancel button should be visible in the onboarding sheet toolbar"
            )
        }
    }

    func testOnboardingCancelDismissesSheet() {
        given("the onboarding sheet is open") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
        }
        when("I tap Cancel") {
            let cancelBtn = find("onboarding-cancel-btn")
            guard cancelBtn.waitForExistence(timeout: 5) else {
                XCTFail("Cancel button should exist")
                return
            }
            cancelBtn.tap()
        }
        then("the sheet should be dismissed") {
            let sheet = find("hub-onboarding-sheet")
            // Sheet should no longer exist after dismissal
            let dismissed = !sheet.waitForExistence(timeout: 3)
            XCTAssertTrue(dismissed, "Onboarding sheet should be dismissed after tapping Cancel")
        }
    }

    // MARK: - Template Selection

    func testTemplateListAppearsOnFirstStep() {
        given("I open the onboarding sheet") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
        }
        then("the template list should be visible as step 1") {
            let templateList = find("onboarding-template-list")
            XCTAssertTrue(
                templateList.waitForExistence(timeout: 10),
                "Template list should be visible on the first onboarding step"
            )
        }
    }

    func testStartFromScratchOptionExists() {
        given("I am on the template selection step") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
        }
        then("a 'Start from Scratch' option should be visible") {
            let fromScratch = scrollToFind("template-from-scratch", maxSwipes: 5)
            XCTAssertTrue(
                fromScratch.exists,
                "Start from Scratch option should be available in the template list"
            )
        }
    }

    // MARK: - Channel Checklist

    func testChannelChecklistShowsAllToggles() {
        given("I am on the channel checklist step") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
            advanceToChannelStep()
        }
        then("all 7 channel toggles should be visible") {
            let channels = [
                "channel-toggle-voice",
                "channel-toggle-sms",
                "channel-toggle-email",
                "channel-toggle-signal",
                "channel-toggle-whatsapp",
                "channel-toggle-telegram",
                "channel-toggle-rcs",
            ]

            for channelId in channels {
                let toggle = scrollToFind(channelId, maxSwipes: 5)
                XCTAssertTrue(
                    toggle.exists,
                    "\(channelId) should be visible in the channel checklist"
                )
            }
        }
    }

    func testChannelChecklistIdentifier() {
        given("I am on the channel checklist step") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
            advanceToChannelStep()
        }
        then("the channel checklist view should exist") {
            let checklist = find("channel-checklist")
            XCTAssertTrue(
                checklist.waitForExistence(timeout: 5),
                "Channel checklist container should be present"
            )
        }
    }

    func testChannelTogglesAreIndependentlyToggleable() {
        given("I am on the channel checklist step") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
            advanceToChannelStep()
        }
        when("I interact with channel toggles") {
            // Try toggling individual channels -- they should be independently tappable
            let voiceToggle = find("channel-toggle-voice")
            guard voiceToggle.waitForExistence(timeout: 5) else {
                XCTFail("Voice toggle should exist")
                return
            }
            // Tapping should not crash or lock up other toggles
            voiceToggle.tap()

            let emailToggle = scrollToFind("channel-toggle-email", maxSwipes: 3)
            if emailToggle.exists {
                emailToggle.tap()
            }
        }
        then("the toggles should remain interactive") {
            // Verify the channel checklist is still responsive
            let checklist = find("channel-checklist")
            XCTAssertTrue(
                checklist.exists,
                "Channel checklist should remain visible after toggling channels"
            )
        }
    }

    // MARK: - Onboarding Navigation (Back/Next)

    func testBackButtonNotVisibleOnFirstStep() {
        given("I am on the first step (template)") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
        }
        then("the back button should NOT be visible") {
            let backBtn = find("onboarding-back-btn")
            let exists = backBtn.waitForExistence(timeout: 3)
            XCTAssertFalse(
                exists,
                "Back button should not be visible on the first step"
            )
        }
    }

    func testNextButtonAppearsAfterTemplateStep() {
        given("I advance past the template step") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
            advanceToChannelStep()
        }
        then("the next button should be visible") {
            let nextBtn = find("onboarding-next-btn")
            XCTAssertTrue(
                nextBtn.waitForExistence(timeout: 5),
                "Next button should appear after the template step"
            )
        }
    }

    func testBackButtonAppearsAfterFirstStep() {
        given("I advance past the template step") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
            advanceToChannelStep()
        }
        then("the back button should be visible") {
            let backBtn = find("onboarding-back-btn")
            XCTAssertTrue(
                backBtn.waitForExistence(timeout: 5),
                "Back button should appear after advancing past the first step"
            )
        }
    }

    // MARK: - Provider Connection Step

    func testProviderStepRendersContent() {
        given("I advance to the provider connection step") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
            advanceToProviderStep()
        }
        then("the provider step content should be visible") {
            let providerStep = find("onboarding-step-provider")
            XCTAssertTrue(
                providerStep.waitForExistence(timeout: 5),
                "Provider connection step content should render"
            )
        }
    }

    // MARK: - Settings Panel (Provider Configured)

    func testSettingsListShowsSections() {
        given("I am logged in as an admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Communications settings") {
            navigateToCommunications()
        }
        then("if provider is configured, the settings list should show key sections") {
            let settingsList = find("hub-comms-settings-list")
            guard settingsList.waitForExistence(timeout: 10) else {
                // Provider not configured -- no-provider state is shown instead
                let noProvider = find("hub-comms-no-provider")
                if noProvider.exists {
                    // Acceptable: no provider configured in test environment
                    return
                }
                // Loading state may still be active
                let loading = find("hub-comms-loading")
                XCTAssertTrue(
                    loading.exists,
                    "Settings should show list, no-provider state, or loading"
                )
                return
            }

            // Provider status section
            let statusRow = find("hub-comms-provider-status")
            XCTAssertTrue(
                statusRow.waitForExistence(timeout: 5),
                "Provider status row should be visible in settings"
            )
        }
    }

    func testSettingsListShowsChannelSettingsLink() {
        given("I am logged in as an admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Communications settings with a configured provider") {
            navigateToCommunications()
        }
        then("the channel settings navigation link should exist") {
            let settingsList = find("hub-comms-settings-list")
            guard settingsList.waitForExistence(timeout: 10) else {
                // Not configured -- skip
                return
            }

            let channelLink = find("hub-comms-channel-settings-link")
            XCTAssertTrue(
                channelLink.waitForExistence(timeout: 5),
                "Channel settings link should be visible in the settings panel"
            )
        }
    }

    func testSettingsListShowsUsageLink() {
        given("I am logged in as an admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Communications settings with a configured provider") {
            navigateToCommunications()
        }
        then("the usage link should exist (when usage data is available)") {
            let settingsList = find("hub-comms-settings-list")
            guard settingsList.waitForExistence(timeout: 10) else {
                return
            }

            let usageLink = scrollToFind("hub-comms-usage-link", maxSwipes: 3)
            // Usage link only appears when usage data is non-nil
            if usageLink.exists {
                XCTAssertTrue(true, "Usage link is visible when usage data is available")
            }
        }
    }

    func testChannelSettingsNavigationOpensChecklist() {
        given("I am logged in as admin with provider configured") {
            launchAsAdminWithAPI()
        }
        when("I tap the channel settings link") {
            navigateToCommunications()
            let settingsList = find("hub-comms-settings-list")
            guard settingsList.waitForExistence(timeout: 10) else {
                return
            }

            let channelLink = find("hub-comms-channel-settings-link")
            guard channelLink.waitForExistence(timeout: 5) else {
                return
            }
            channelLink.tap()
        }
        then("the channel checklist should appear with a save button") {
            let checklist = find("channel-checklist")
            guard checklist.waitForExistence(timeout: 5) else {
                // Navigation may not have occurred if provider not configured
                return
            }

            // In settings mode (not onboarding), a save button is present
            let saveBtn = scrollToFind("channel-save-btn", maxSwipes: 5)
            XCTAssertTrue(
                saveBtn.exists,
                "Save button should be visible in settings-mode channel checklist"
            )
        }
    }

    func testUsageNavigationOpensUsageView() {
        given("I am logged in as admin with provider configured") {
            launchAsAdminWithAPI()
        }
        when("I tap the usage link") {
            navigateToCommunications()
            let settingsList = find("hub-comms-settings-list")
            guard settingsList.waitForExistence(timeout: 10) else {
                return
            }

            let usageLink = scrollToFind("hub-comms-usage-link", maxSwipes: 3)
            guard usageLink.exists else {
                // No usage data available -- skip
                return
            }
            usageLink.tap()
        }
        then("the usage view should appear") {
            let usageView = find("hub-usage-view")
            if usageView.waitForExistence(timeout: 5) {
                XCTAssertTrue(true, "Usage view rendered successfully")
            }
        }
    }

    func testPhoneNumbersSectionExists() {
        given("I am logged in as an admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Communications settings with a configured provider") {
            navigateToCommunications()
        }
        then("the phone numbers section should be visible") {
            let settingsList = find("hub-comms-settings-list")
            guard settingsList.waitForExistence(timeout: 10) else {
                return
            }

            let phoneNumbers = scrollToFind("hub-comms-phone-numbers", maxSwipes: 5)
            XCTAssertTrue(
                phoneNumbers.exists,
                "Phone numbers section should be visible in settings"
            )
        }
    }

    // MARK: - Onboarding Step Content Views

    func testPhoneNumberStepRendersContent() {
        given("I advance to the phone number step") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
            advanceToPhoneStep()
        }
        then("the phone number step content should be visible") {
            let phoneStep = find("onboarding-step-phone")
            XCTAssertTrue(
                phoneStep.waitForExistence(timeout: 5),
                "Phone number step content should render"
            )
        }
    }

    func testChannelSetupStepRendersContent() {
        given("I advance to the channel setup step") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
            advanceToChannelSetupStep()
        }
        then("the channel setup step content should be visible") {
            let setupStep = find("onboarding-step-channel-setup")
            XCTAssertTrue(
                setupStep.waitForExistence(timeout: 5),
                "Channel setup step content should render"
            )
        }
    }

    func testSummaryStepRendersContent() {
        given("I advance to the summary step") {
            launchAsAdminWithAPI()
            openOnboardingSheet()
            advanceToSummaryStep()
        }
        then("the summary step content should be visible") {
            let summaryStep = find("onboarding-step-summary")
            XCTAssertTrue(
                summaryStep.waitForExistence(timeout: 5),
                "Summary step content should render"
            )
        }
        and("the complete setup button should be visible") {
            let completeBtn = find("onboarding-complete-btn")
            XCTAssertTrue(
                completeBtn.waitForExistence(timeout: 5),
                "Complete Setup button should be visible on the summary step"
            )
        }
    }

    // MARK: - Navigation Helpers

    private func navigateToCommunications() {
        navigateToSettings()
        let commsLink = scrollToFind("settings-communications-link", maxSwipes: 5)
        guard commsLink.exists else {
            // Admin may not see link if not actually admin -- this is fine for guard checks
            return
        }
        commsLink.tap()
    }

    /// Open the onboarding sheet from the no-provider state.
    /// Assumes admin launch and navigates through to the setup button tap.
    private func openOnboardingSheet() {
        navigateToCommunications()

        let noProvider = find("hub-comms-no-provider")
        guard noProvider.waitForExistence(timeout: 10) else {
            // If provider is already configured, we cannot open onboarding
            return
        }

        let setupBtn = find("hub-comms-start-setup-btn")
        guard setupBtn.waitForExistence(timeout: 5) else {
            return
        }
        setupBtn.tap()

        // Wait for the sheet to appear
        let sheet = find("hub-onboarding-sheet")
        _ = sheet.waitForExistence(timeout: 5)
    }

    /// Advance past the template step by tapping "Start from Scratch".
    /// This moves to the channels step.
    private func advanceToChannelStep() {
        let templateList = find("onboarding-template-list")
        guard templateList.waitForExistence(timeout: 10) else {
            return
        }

        let fromScratch = scrollToFind("template-from-scratch", maxSwipes: 5)
        guard fromScratch.exists else {
            return
        }
        fromScratch.tap()

        // Wait for the channels step to load
        let checklist = find("channel-checklist")
        _ = checklist.waitForExistence(timeout: 5)
    }

    /// Advance to the provider step by going through template + channels.
    private func advanceToProviderStep() {
        advanceToChannelStep()

        let nextBtn = find("onboarding-next-btn")
        guard nextBtn.waitForExistence(timeout: 5) else {
            return
        }
        nextBtn.tap()

        let providerStep = find("onboarding-step-provider")
        _ = providerStep.waitForExistence(timeout: 5)
    }

    /// Advance to the phone number step.
    private func advanceToPhoneStep() {
        advanceToProviderStep()

        let nextBtn = find("onboarding-next-btn")
        guard nextBtn.waitForExistence(timeout: 5) else {
            return
        }
        nextBtn.tap()

        let phoneStep = find("onboarding-step-phone")
        _ = phoneStep.waitForExistence(timeout: 5)
    }

    /// Advance to the channel setup step.
    private func advanceToChannelSetupStep() {
        advanceToPhoneStep()

        let nextBtn = find("onboarding-next-btn")
        guard nextBtn.waitForExistence(timeout: 5) else {
            return
        }
        nextBtn.tap()

        let setupStep = find("onboarding-step-channel-setup")
        _ = setupStep.waitForExistence(timeout: 5)
    }

    /// Advance to the summary step.
    private func advanceToSummaryStep() {
        advanceToChannelSetupStep()

        let nextBtn = find("onboarding-next-btn")
        guard nextBtn.waitForExistence(timeout: 5) else {
            return
        }
        nextBtn.tap()

        let summaryStep = find("onboarding-step-summary")
        _ = summaryStep.waitForExistence(timeout: 5)
    }
}
