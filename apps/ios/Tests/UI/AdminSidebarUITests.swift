import XCTest

/// XCUITest suite for the admin sidebar navigation view.
///
/// Verifies that the sidebar renders with correct scope headers ("This Hub" / "Platform"),
/// displays the expected nav items with accessibility identifiers, and that tapping
/// a nav item triggers navigation.
///
/// Runs as a super-admin registered with the live backend (`launchAsAdminWithAPI`):
/// admin UI is gated on server-granted permissions, which an offline launch never has.
final class AdminSidebarUITests: BaseUITest {

    override func setUp() {
        super.setUp()
        launchAsAdminWithAPI()
    }

    // MARK: - Sidebar Rendering

    func testAdminSidebarListExists() {
        navigateToAdminPanel()

        let sidebarList = find("admin-sidebar-list")
        XCTAssertTrue(
            sidebarList.waitForExistence(timeout: 10),
            "Admin sidebar list should be visible after navigating to admin panel"
        )
    }

    func testThisHubScopeHeaderVisible() {
        navigateToAdminPanel()

        let header = find("admin-sidebar-header-this-hub")
        XCTAssertTrue(
            header.waitForExistence(timeout: 10),
            "'This Hub' scope header should be visible in admin sidebar"
        )
    }

    func testPlatformScopeHeaderVisible() {
        navigateToAdminPanel()

        // Platform section is only visible to super-admins with the right role.
        // The launched identity is a super-admin registered with the backend.
        let header = scrollToFind("admin-sidebar-header-platform")
        XCTAssertTrue(
            header.exists,
            "'Platform' scope header should be visible for super-admin users"
        )
    }

    // MARK: - This Hub Nav Items

    func testThisHubNavItemsPresent() {
        navigateToAdminPanel()

        // Representative subset of "This Hub" items — verifies the ForEach rendered them.
        let expectedItems = [
            "admin-sidebar-item-location-lookup",
            "admin-sidebar-item-custom-fields",
            "admin-sidebar-item-call-settings",
            "admin-sidebar-item-bans",
            "admin-sidebar-item-audit",
        ]

        for testid in expectedItems {
            let element = scrollToFind(testid)
            XCTAssertTrue(element.exists, "\(testid) should exist in admin sidebar 'This Hub' section")
        }
    }

    func testAllThisHubNavItemsRendered() {
        navigateToAdminPanel()

        // Full set of "This Hub" nav items from AdminNavConfig
        let allThisHubItems = [
            "admin-sidebar-item-location-lookup",
            "admin-sidebar-item-passkey-policy",
            "admin-sidebar-item-recovery-group",
            "admin-sidebar-item-devices",
            "admin-sidebar-item-hub-roles",
            "admin-sidebar-item-teams",
            "admin-sidebar-item-tags",
            "admin-sidebar-item-custom-fields",
            "admin-sidebar-item-report-types",
            "admin-sidebar-item-firehose",
            "admin-sidebar-item-call-settings",
            "admin-sidebar-item-voice-prompts",
            "admin-sidebar-item-phone-menu-languages",
            "admin-sidebar-item-transcription",
            "admin-sidebar-item-spam-protection",
            "admin-sidebar-item-phone-provider",
            "admin-sidebar-item-messaging-sms",
            "admin-sidebar-item-rcs",
            "admin-sidebar-item-signal",
            "admin-sidebar-item-bans",
            "admin-sidebar-item-audit",
            "admin-sidebar-item-analytics",
            "admin-sidebar-item-health",
        ]

        for testid in allThisHubItems {
            let element = scrollToFind(testid)
            XCTAssertTrue(element.exists, "\(testid) should exist in admin sidebar")
        }
    }

    // MARK: - Platform Nav Items

    func testPlatformNavItemsPresent() {
        navigateToAdminPanel()

        // Platform items require role-super-admin, which the launched identity has.
        let platformItems = [
            "admin-sidebar-item-hubs",
            "admin-sidebar-item-platform-roles",
            "admin-sidebar-item-platform-bans",
            "admin-sidebar-item-platform-audit",
            "admin-sidebar-item-platform-analytics",
            "admin-sidebar-item-platform-health",
            "admin-sidebar-item-platform-settings",
            "admin-sidebar-item-gdpr-erasure",
        ]

        for testid in platformItems {
            let element = scrollToFind(testid)
            XCTAssertTrue(element.exists, "\(testid) should exist in admin sidebar 'Platform' section")
        }
    }

    // MARK: - Navigation on Tap

    func testTapLocationLookupNavigates() {
        navigateToAdminPanel()

        let item = scrollToFind("admin-sidebar-item-location-lookup")
        guard item.exists else {
            XCTFail("Location lookup nav item should exist")
            return
        }
        item.tap()

        // AdminSidebarView wires no navigation destination (#1245) — the most
        // concrete thing this test can check today is that tapping didn't
        // crash the app and the sidebar list is still queryable.
        let sidebarList = find("admin-sidebar-list")
        XCTAssertTrue(
            sidebarList.waitForExistence(timeout: 5),
            "Admin sidebar list should remain visible after tapping a nav item"
        )
    }

    func testTapCallSettingsNavigates() {
        navigateToAdminPanel()

        let item = scrollToFind("admin-sidebar-item-call-settings")
        guard item.exists else {
            XCTFail("Call settings nav item should exist")
            return
        }
        item.tap()

        // AdminSidebarView wires no navigation destination (#1245) — verify
        // the sidebar is still queryable rather than asserting a tautology.
        XCTAssertTrue(
            find("admin-sidebar-list").waitForExistence(timeout: 5),
            "Admin sidebar list should remain visible after tapping a nav item"
        )
    }

    func testTapBansNavigates() {
        navigateToAdminPanel()

        let item = scrollToFind("admin-sidebar-item-bans")
        guard item.exists else {
            XCTFail("Bans nav item should exist")
            return
        }
        item.tap()

        // AdminSidebarView wires no navigation destination (#1245) — verify
        // the sidebar is still queryable rather than asserting a tautology.
        XCTAssertTrue(
            find("admin-sidebar-list").waitForExistence(timeout: 5),
            "Admin sidebar list should remain visible after tapping a nav item"
        )
    }

    func testTapPlatformHubsNavigates() {
        navigateToAdminPanel()

        // The launched identity is a super-admin (class doc above), so the
        // Platform section's items should always be present.
        let item = scrollToFind("admin-sidebar-item-hubs")
        guard item.exists else {
            XCTFail("Platform hubs nav item should exist for a super-admin")
            return
        }
        item.tap()

        // AdminSidebarView wires no navigation destination (#1245) — verify
        // the sidebar is still queryable rather than asserting a tautology.
        XCTAssertTrue(
            find("admin-sidebar-list").waitForExistence(timeout: 5),
            "Admin sidebar list should remain visible after tapping a nav item"
        )
    }
}
