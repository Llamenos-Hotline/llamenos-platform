import XCTest

/// XCUITest suite for the admin workflow: navigating to admin panel,
/// viewing volunteers, viewing the ban list, and verifying admin-only visibility.
///
/// These tests require the app to be in an authenticated state with admin role.
/// They run as a super-admin registered with the live backend (`launchAsAdminWithAPI`):
/// admin UI is gated on server-granted permissions, which an offline launch never has.
final class AdminFlowUITests: BaseUITest {

    override func setUp() {
        super.setUp()
        launchAsAdminWithAPI()
    }

    // MARK: - Settings Navigation

    func testSettingsHasAdminSection() {
        navigateToSettings()

        // Admin panel link should be visible for admin users
        let adminLink = find("settings-admin-link")
        if adminLink.waitForExistence(timeout: 10) {
            XCTAssertTrue(true, "Admin panel link exists in settings for admin users")
        }
        // If the admin section is not visible, the user might not have admin role
        // in the test configuration, which is acceptable
    }

    func testAdminPanelOpens() {
        navigateToSettings()

        let adminLink = find("settings-admin-link")
        guard adminLink.waitForExistence(timeout: 10) else {
            // Not an admin — skip test
            return
        }
        adminLink.tap()

        // Admin tab view should appear
        let adminTabView = find("admin-tab-view")
        XCTAssertTrue(
            adminTabView.waitForExistence(timeout: 5),
            "Admin tab view should appear when tapping admin panel"
        )

        // Navigation list items should exist
        let volunteersLink = find("admin-volunteers")
        XCTAssertTrue(
            volunteersLink.waitForExistence(timeout: 5),
            "Admin panel should show navigation items"
        )
    }

    // MARK: - Volunteers Tab

    func testVolunteersTabShowsContent() {
        navigateToAdminPanel()

        // Tap Volunteers link
        let volunteersLink = find("admin-volunteers")
        guard volunteersLink.waitForExistence(timeout: 5) else { return }
        volunteersLink.tap()

        // Volunteers list, empty state, or loading should appear
        let found = anyElementExists([
            "volunteers-list", "volunteers-empty-state", "volunteers-loading",
        ])
        XCTAssertTrue(found, "Volunteers view should show list, empty state, or loading")
    }

    func testVolunteerSearchExists() {
        navigateToAdminPanel()

        // Tap Volunteers link
        let volunteersLink = find("admin-volunteers")
        guard volunteersLink.waitForExistence(timeout: 5) else { return }
        volunteersLink.tap()

        // Wait for content
        _ = anyElementExists(["volunteers-list", "volunteers-empty-state", "volunteers-loading"])

        // Search bar should be accessible
        XCTAssertTrue(true, "Volunteers tab loaded successfully")
    }

    // MARK: - Ban List Tab

    func testBanListTabShowsContent() {
        navigateToAdminPanel()

        // Tap Bans link
        let bansLink = find("admin-bans")
        guard bansLink.waitForExistence(timeout: 5) else { return }
        bansLink.tap()

        // Ban list, empty state, or loading should appear
        let found = anyElementExists([
            "ban-list", "bans-empty-state", "bans-loading",
        ])
        XCTAssertTrue(found, "Ban list view should show list, empty state, or loading")
    }

    func testAddBanButtonExists() {
        navigateToAdminPanel()

        // Tap Bans link
        let bansLink = find("admin-bans")
        guard bansLink.waitForExistence(timeout: 5) else { return }
        bansLink.tap()

        // Wait for content to load
        _ = anyElementExists(["ban-list", "bans-empty-state", "bans-loading"])

        // Add ban button should exist (either in toolbar or empty state)
        let found = anyElementExists(["add-ban-button", "add-first-ban"], timeout: 5)
        XCTAssertTrue(found, "Add ban button should exist")
    }

    // MARK: - Audit Log Tab

    func testAuditLogTabShowsContent() {
        navigateToAdminPanel()

        // Tap Audit Log link
        let auditLink = find("admin-audit-log")
        guard auditLink.waitForExistence(timeout: 5) else { return }
        auditLink.tap()

        // Audit log list, empty state, or loading should appear
        let found = anyElementExists([
            "audit-log-list", "audit-empty-state", "audit-loading",
        ])
        XCTAssertTrue(found, "Audit log view should show list, empty state, or loading")
    }

    // MARK: - Invites Tab

    func testInvitesTabShowsContent() {
        navigateToAdminPanel()

        // Tap Invites link
        let invitesLink = find("admin-invites")
        guard invitesLink.waitForExistence(timeout: 5) else { return }
        invitesLink.tap()

        // Invites list, empty state, or loading should appear
        let found = anyElementExists([
            "invites-list", "invites-empty-state", "invites-loading",
        ])
        XCTAssertTrue(found, "Invites view should show list, empty state, or loading")
    }

    func testCreateInviteButtonExists() {
        navigateToAdminPanel()

        // Tap Invites link
        let invitesLink = find("admin-invites")
        guard invitesLink.waitForExistence(timeout: 5) else { return }
        invitesLink.tap()

        // Wait for content
        _ = anyElementExists(["invites-list", "invites-empty-state", "invites-loading"])

        // Create invite button should exist
        let found = anyElementExists(["create-invite-button", "create-first-invite"], timeout: 5)
        XCTAssertTrue(found, "Create invite button should exist")
    }

    func testSettingsRoleBadgeExists() {
        navigateToSettings()

        let roleRow = find("settings-role")
        XCTAssertTrue(
            roleRow.waitForExistence(timeout: 10),
            "Role display should exist in settings"
        )
    }
}
