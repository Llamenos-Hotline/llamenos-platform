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

        let adminLink = scrollToFind("settings-admin-link", maxSwipes: 5, timeout: 10)
        XCTAssertTrue(adminLink.exists, "Admin panel link should exist in settings for admin users")
    }

    func testAdminPanelOpens() {
        // navigateToAdminPanel fails the test if the link or the panel is missing.
        navigateToAdminPanel()

        XCTAssertTrue(
            find("admin-volunteers").waitForExistence(timeout: 5),
            "Admin panel should show navigation items"
        )
    }

    // MARK: - Volunteers Tab

    /// Put a named volunteer in the class hub through the real admin API.
    private func seedVolunteer(named name: String) {
        let pubkey = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        TestAdminAPI.send(
            "POST", "/api/users",
            ["pubkey": pubkey, "name": name, "phone": "", "roleIds": ["role-volunteer"]],
            baseURL: testHubURL
        )
        TestAdminAPI.send(
            "POST", "/api/hubs/\(testHubId)/members",
            ["pubkey": pubkey, "roleIds": ["role-volunteer"]],
            baseURL: testHubURL
        )
    }

    /// Open one screen of the admin panel, failing the test if its link is missing.
    private func openAdminScreen(_ linkIdentifier: String) {
        navigateToAdminPanel()
        let link = scrollToFind(linkIdentifier, maxSwipes: 3, timeout: 5)
        XCTAssertTrue(link.exists, "Admin panel should offer '\(linkIdentifier)'")
        link.tap()
    }

    /// The list is read from `GET /api/identity/members` (mounted by #1917). If that read
    /// fails the screen falls to its empty state and this fails on the missing list.
    func testVolunteersTabShowsContent() {
        let name = "Seeded volunteer \(UUID().uuidString.prefix(8))"
        seedVolunteer(named: name)

        openAdminScreen("admin-volunteers")

        XCTAssertTrue(
            find("volunteers-list").waitForExistence(timeout: 15),
            "A hub with members should show the volunteers list, not the empty state"
        )
        // Admins sort first and every test in the class registers one into the class hub, so
        // the volunteer is below the fold; a List only instantiates the rows it has scrolled to.
        let row = scrollToMatch(NSPredicate(format: "label == %@", name))
        XCTAssertTrue(row.exists, "The seeded volunteer should be listed by name")
    }

    func testVolunteerSearchExists() {
        openAdminScreen("admin-volunteers")

        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10), "The volunteers screen should have a search field")
        search.tap()
        search.typeText("alice")
        XCTAssertEqual(
            search.value as? String, "alice",
            "The search field should accept the query that filters the list"
        )
    }

    // MARK: - Ban List Tab

    func testBanListTabShowsContent() {
        openAdminScreen("admin-bans")

        // Settled: a list or the empty state, never still loading.
        let found = anyElementExists(["ban-list", "bans-empty-state"])
        XCTAssertTrue(found, "Ban list view should show list or empty state")
    }

    func testAddBanEnablesSubmissionAfterEnteringAnIdentifier() {
        openAdminScreen("admin-bans")

        // The identifier belongs to a SwiftUI toolbar Button. Query the button
        // itself so tapping it exercises the action rather than its container.
        app.buttons["add-ban-button"].tap()

        let identifierInput = app.textFields["ban-hash-input"]
        identifierInput.tap()
        identifierInput.typeText(String(repeating: "a", count: 64))

        XCTAssertTrue(
            app.buttons["submit-add-ban"].isEnabled,
            "Entering a ban identifier should enable submission"
        )
    }

    // MARK: - Audit Log Tab

    func testAuditLogTabShowsContent() {
        openAdminScreen("admin-audit-log")

        let found = anyElementExists(["audit-log-list", "audit-empty-state"])
        XCTAssertTrue(found, "Audit log view should show list or empty state")
    }

    // MARK: - Invites Tab

    func testInvitesTabShowsContent() {
        openAdminScreen("admin-invites")

        let found = anyElementExists(["invites-list", "invites-empty-state"])
        XCTAssertTrue(found, "Invites view should show list or empty state")
    }

    func testCreateInviteButtonExists() {
        openAdminScreen("admin-invites")

        // Wait for content
        _ = anyElementExists(["invites-list", "invites-empty-state"])

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
