import XCTest

/// BDD tests for the Contacts & Timeline feature (Epic 243).
/// Tests admin-only visibility and navigation to the contacts screen.
/// Note: Detailed view tests require a live API (Epic 240) — mock mode causes
/// XCUITest idle detection issues with SwiftUI async tasks.
final class ContactsUITests: BaseUITest {

    // MARK: - Scenario: Contacts quick action visible for admin

    func testContactsQuickActionVisibleForAdmin() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        then("the dashboard should show a contacts quick action") {
            let contactsAction = scrollToFind("dashboard-contacts-action")
            XCTAssertTrue(
                contactsAction.exists,
                "Dashboard should have a contacts quick action card for admin"
            )
        }
    }

    // MARK: - Scenario: Contacts quick action hidden for volunteer

    func testContactsQuickActionHiddenForVolunteer() {
        given("I am authenticated as a volunteer") {
            launchAuthenticated()
        }
        then("the dashboard should not show a contacts quick action") {
            let contactsAction = find("dashboard-contacts-action")
            XCTAssertFalse(
                contactsAction.waitForExistence(timeout: 3),
                "Dashboard should not have contacts quick action for volunteer"
            )
        }
    }

    // MARK: - Scenario: Contacts navigation link is tappable

    func testContactsActionIsTappable() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        then("the contacts action should exist and be accessible") {
            let contactsAction = scrollToFind("dashboard-contacts-action")
            XCTAssertTrue(contactsAction.exists, "Contacts action should exist")
            XCTAssertTrue(contactsAction.isEnabled, "Contacts action should be enabled")
        }
    }
}
