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

    func testCommunicationsViewShowsNoProviderForNewHub() {
        given("I am logged in as an admin of a hub nobody has configured") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Communications settings") {
            navigateToCommunications()
        }
        then("the view settles on the no-provider state") {
            XCTAssertTrue(
                find("hub-comms-no-provider").waitForExistence(timeout: 20),
                "A hub with no provider should show the no-provider state"
            )
            XCTAssertFalse(find("hub-comms-loading").exists, "Communications should have finished loading")
            XCTAssertFalse(find("hub-comms-settings-list").exists, "There are no settings for a provider that is not set up")
        }
    }

    func testCommunicationsViewShowsSettingsForConfiguredHub() {
        given("I am logged in as an admin of a hub whose setup is complete") {
            launchAsAdminOnConfiguredHub()
        }
        when("I navigate to Communications settings") {
            navigateToCommunications()
        }
        then("the view settles on the settings list") {
            XCTAssertTrue(
                find("hub-comms-settings-list").waitForExistence(timeout: 20),
                "A hub with completed setup should show its settings"
            )
            XCTAssertFalse(find("hub-comms-loading").exists, "Communications should have finished loading")
            XCTAssertFalse(find("hub-comms-no-provider").exists, "A set-up hub is not in the no-provider state")
        }
    }

    func testNoProviderStateShowsSetupButton() {
        given("I am logged in as an admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Communications settings") {
            navigateToCommunications()
        }
        then("the setup button should appear") {
            let noProvider = find("hub-comms-no-provider")
            XCTAssertTrue(noProvider.waitForExistence(timeout: 20), "A hub with no provider should show the no-provider state")
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
            XCTAssertTrue(noProvider.waitForExistence(timeout: 20), "A hub with no provider should show the no-provider state")
            let setupButton = find("hub-comms-start-setup-btn")
            XCTAssertTrue(setupButton.waitForExistence(timeout: 5), "Start Setup button should exist")
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
            XCTAssertTrue(emailToggle.exists, "Email toggle should exist")
            emailToggle.tap()
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
            launchAsAdminOnConfiguredHub()
        }
        when("I navigate to Communications settings") {
            navigateToCommunications()
        }
        then("the settings list should show key sections") {
            let settingsList = find("hub-comms-settings-list")
            XCTAssertTrue(
                settingsList.waitForExistence(timeout: 20),
                "A hub with completed setup should show its settings list"
            )

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
            launchAsAdminOnConfiguredHub()
        }
        when("I navigate to Communications settings with a configured provider") {
            navigateToCommunications()
        }
        then("the channel settings navigation link should exist") {
            let settingsList = find("hub-comms-settings-list")
            XCTAssertTrue(settingsList.waitForExistence(timeout: 20), "Settings list should be shown")

            let channelLink = find("hub-comms-channel-settings-link")
            XCTAssertTrue(
                channelLink.waitForExistence(timeout: 5),
                "Channel settings link should be visible in the settings panel"
            )
        }
    }

    func testSettingsListShowsUsageLink() {
        given("I am logged in as an admin") {
            launchAsAdminOnConfiguredHub()
        }
        when("I navigate to Communications settings with a configured provider") {
            navigateToCommunications()
        }
        then("the usage link should exist") {
            let settingsList = find("hub-comms-settings-list")
            XCTAssertTrue(settingsList.waitForExistence(timeout: 20), "Settings list should be shown")

            // The server always reports the current month's usage (zeroes if nothing was
            // used), so a configured hub always has usage data to link to.
            let usageLink = scrollToFind("hub-comms-usage-link", maxSwipes: 3)
            XCTAssertTrue(usageLink.exists, "Usage link should be visible when usage data is available")
        }
    }

    func testChannelSettingsNavigationOpensChecklist() {
        given("I am logged in as admin with provider configured") {
            launchAsAdminOnConfiguredHub()
        }
        when("I tap the channel settings link") {
            navigateToCommunications()
            let settingsList = find("hub-comms-settings-list")
            XCTAssertTrue(settingsList.waitForExistence(timeout: 20), "Settings list should be shown")

            let channelLink = find("hub-comms-channel-settings-link")
            XCTAssertTrue(channelLink.waitForExistence(timeout: 5), "Channel settings link should exist")
            channelLink.tap()
        }
        then("the channel checklist should appear with a save button") {
            let checklist = find("channel-checklist")
            XCTAssertTrue(checklist.waitForExistence(timeout: 5), "Channel checklist should open")

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
            launchAsAdminOnConfiguredHub()
        }
        when("I tap the usage link") {
            navigateToCommunications()
            let settingsList = find("hub-comms-settings-list")
            XCTAssertTrue(settingsList.waitForExistence(timeout: 20), "Settings list should be shown")

            let usageLink = scrollToFind("hub-comms-usage-link", maxSwipes: 3)
            XCTAssertTrue(usageLink.exists, "Usage link should exist")
            usageLink.tap()
        }
        then("the usage view should appear") {
            let usageView = find("hub-usage-view")
            XCTAssertTrue(usageView.waitForExistence(timeout: 5), "Usage view should render")
        }
    }

    func testPhoneNumbersSectionExists() {
        given("I am logged in as an admin") {
            launchAsAdminOnConfiguredHub()
        }
        when("I navigate to Communications settings with a configured provider") {
            navigateToCommunications()
        }
        then("the phone numbers section should be visible") {
            let settingsList = find("hub-comms-settings-list")
            XCTAssertTrue(settingsList.waitForExistence(timeout: 20), "Settings list should be shown")

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

    /// Launch as an admin of a hub whose communications setup is complete: a fresh hub
    /// taken through every onboarding step on the server, so the Communications screen
    /// shows its settings rather than the no-provider state. A fresh hub, because the
    /// class hub must stay unconfigured for the no-provider scenarios.
    private func launchAsAdminOnConfiguredHub() {
        guard let hubId = TestAdminAPI.createHub(
            name: "comms-\(UUID().uuidString.prefix(8))", baseURL: testHubURL
        ) else { return }
        let onboard = "/api/hubs/\(hubId)/onboard"
        TestAdminAPI.send("POST", onboard, [:], baseURL: testHubURL)
        for step in ["template_selection", "channel_selection", "provider_connection", "phone_number", "channel_setup"] {
            TestAdminAPI.send("PUT", "\(onboard)/step", ["step": step], baseURL: testHubURL)
        }
        launchAsAdminWithAPI(hubId: hubId)
    }

    private func navigateToCommunications() {
        navigateToSettings()
        let commsLink = scrollToFind("settings-communications-link", maxSwipes: 5)
        XCTAssertTrue(commsLink.exists, "The Communications link should be offered to an admin")
        commsLink.tap()
    }

    /// Open the onboarding sheet from the no-provider state.
    /// Assumes admin launch and navigates through to the setup button tap.
    private func openOnboardingSheet() {
        navigateToCommunications()

        XCTAssertTrue(
            find("hub-comms-no-provider").waitForExistence(timeout: 20),
            "Onboarding opens from the no-provider state"
        )
        let setupBtn = find("hub-comms-start-setup-btn")
        XCTAssertTrue(setupBtn.waitForExistence(timeout: 5), "Start Setup button should exist")
        setupBtn.tap()

        XCTAssertTrue(
            find("hub-onboarding-sheet").waitForExistence(timeout: 5),
            "Onboarding sheet should be presented after tapping Start Setup"
        )
    }

    /// Advance past the template step by tapping "Start from Scratch".
    /// This moves to the channels step.
    private func advanceToChannelStep() {
        XCTAssertTrue(
            find("onboarding-template-list").waitForExistence(timeout: 10),
            "The onboarding sheet opens on the template list"
        )
        let fromScratch = scrollToFind("template-from-scratch", maxSwipes: 5)
        XCTAssertTrue(fromScratch.exists, "Start from Scratch should be offered")
        fromScratch.tap()

        XCTAssertTrue(
            find("channel-checklist").waitForExistence(timeout: 5),
            "Choosing a template should move to the channels step"
        )
    }

    /// Tap Next and wait for the step with this identifier.
    private func tapNext(toReach stepIdentifier: String) {
        let nextBtn = find("onboarding-next-btn")
        XCTAssertTrue(nextBtn.waitForExistence(timeout: 5), "Next button should exist")
        nextBtn.tap()
        XCTAssertTrue(
            find(stepIdentifier).waitForExistence(timeout: 5),
            "Next should reach '\(stepIdentifier)'"
        )
    }

    /// Advance to the provider step by going through template + channels.
    private func advanceToProviderStep() {
        advanceToChannelStep()
        tapNext(toReach: "onboarding-step-provider")
    }

    /// Advance to the phone number step.
    private func advanceToPhoneStep() {
        advanceToProviderStep()
        tapNext(toReach: "onboarding-step-phone")
    }

    /// Advance to the channel setup step.
    private func advanceToChannelSetupStep() {
        advanceToPhoneStep()
        tapNext(toReach: "onboarding-step-channel-setup")
    }

    /// Advance to the summary step.
    private func advanceToSummaryStep() {
        advanceToChannelSetupStep()
        tapNext(toReach: "onboarding-step-summary")
    }
}
