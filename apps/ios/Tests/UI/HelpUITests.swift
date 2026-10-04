import XCTest

/// BDD tests for the Help screen (Epic 242).
final class HelpUITests: BaseUITest {

    // MARK: - Scenario: Help screen shows security section

    func testHelpScreenShowsSecuritySection() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to the help screen") {
            navigateToSettings()
            let helpButton = scrollToFind("settings-help")
            XCTAssertTrue(helpButton.waitForExistence(timeout: 5), "Help button should exist in settings")
            helpButton.tap()
        }
        then("I should see the security overview section") {
            let helpScreen = find("help-screen")
            XCTAssertTrue(helpScreen.waitForExistence(timeout: 5), "Help screen should be visible")
            let securitySection = find("help-security-section")
            XCTAssertTrue(securitySection.waitForExistence(timeout: 5), "Security section should exist")
        }
    }

    // MARK: - Scenario: Help screen shows volunteer guide

    func testHelpScreenShowsVolunteerGuide() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to the help screen") {
            navigateToSettings()
            let helpButton = scrollToFind("settings-help")
            XCTAssertTrue(helpButton.waitForExistence(timeout: 5))
            helpButton.tap()
        }
        then("I should see the volunteer guide section") {
            let volunteerGuide = scrollToFind("help-volunteer-guide")
            XCTAssertTrue(volunteerGuide.waitForExistence(timeout: 5), "Volunteer guide should exist")
        }
    }

    // MARK: - Scenario: Admin guide visible for admin users

    func testAdminGuideVisibleForAdmins() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to the help screen") {
            navigateToSettings()
            let helpButton = scrollToFind("settings-help")
            XCTAssertTrue(helpButton.waitForExistence(timeout: 5))
            helpButton.tap()
        }
        then("I should see the admin guide section") {
            let adminGuide = scrollToFind("help-admin-guide")
            XCTAssertTrue(adminGuide.waitForExistence(timeout: 5), "Admin guide should exist for admin users")
        }
    }

    // MARK: - Scenario: FAQ sections are visible

    func testFAQSectionsExist() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to the help screen") {
            navigateToSettings()
            let helpButton = scrollToFind("settings-help")
            XCTAssertTrue(helpButton.waitForExistence(timeout: 5))
            helpButton.tap()
        }
        then("I should see FAQ sections") {
            let faqSection = scrollToFind("help-faq-section")
            XCTAssertTrue(faqSection.waitForExistence(timeout: 5), "FAQ section should exist")
        }
    }
}
