import XCTest

/// XCUITest suite for the admin panel's navigation menu — `AdminTabView`, the
/// screen the app actually presents from Settings → Admin
/// (`ContentView` routes the admin tab to it unconditionally).
///
/// Replaces `AdminSidebarUITests` (#1776). That suite asserted the
/// `admin-sidebar-item-*` identifiers of `AdminSidebarView`, a view nothing in
/// the app ever presents — it was referenced only by its own `#Preview`, so
/// every test in it failed identically on every shard of every scheduled run,
/// and an existence assertion could not say why. `AdminSidebarView` is
/// deleted; the Android-style drawer it mirrored lives only on Android
/// (`admin-sidebar.feature` is `@android`-tagged).
///
/// Per the old suite's five failures, on `main`:
/// - `testAllThisHubNavItemsRendered`, `testPlatformNavItemsPresent`: the
///   `admin-sidebar-item-*` identifiers existed only in the dead view — the
///   items were genuinely absent from the rendered UI, not renamed.
/// - `testTapLocationLookupNavigates`: genuinely obsolete — no location-lookup
///   screen exists anywhere in the iOS app.
/// - `testTapCallSettingsNavigates`, `testTapBansNavigates`: both features
///   exist in the shipped menu (`admin-call-settings`, `admin-bans`) and are
///   covered below by navigation assertions.
///
/// These tests assert the shipped behavior instead: the menu renders every
/// link `AdminTabView` declares, and tapping a link pushes the screen it
/// names — verified by the destination's own identifiers, so a tap that goes
/// nowhere fails loudly instead of passing as "no crash".
///
/// Runs as a super-admin registered with the live backend (`launchAsAdminWithAPI`):
/// admin UI is gated on server-granted permissions, which an offline launch never has.
final class AdminNavigationUITests: BaseUITest {

    override func setUp() {
        super.setUp()
        launchAsAdminWithAPI()
    }

    // MARK: - Menu Rendering

    /// Every navigation link `AdminTabView` declares must render, in layout
    /// order. A missing identifier here is a real regression — a nav link
    /// removed or renamed in the shipped view — not a timeout artifact: each
    /// identifier is defined in `AdminTabView.swift` and checked by
    /// `check-stale-identifiers.py` the moment it stops being.
    func testAdminMenuRendersAllNavLinks() {
        navigateToAdminPanel()

        XCTAssertTrue(
            find("admin-tab-view").waitForExistence(timeout: 10),
            "Admin menu should be visible after navigating to the admin panel"
        )

        // Layout order matches AdminTabView.swift, so the incremental
        // swipe-down search walks the list once instead of re-scrolling.
        let links = [
            "admin-volunteers",
            "admin-bans",
            "admin-audit-log",
            "admin-invites",
            "admin-custom-fields",
            "admin-schema-browser",
            "admin-events",
            "admin-provider-setup",
            "admin-signal-registration",
            "admin-recovery-team",
            "admin-recovery-requests",
            "admin-report-categories",
            "admin-telephony-settings",
            "admin-call-settings",
            "admin-ivr-settings",
            "admin-transcription-settings",
            "admin-spam-settings",
            "admin-erasure-queue",
            "admin-retention-settings",
            "admin-system-health",
        ]

        for link in links {
            let element = scrollToFind(link, maxSwipes: 10)
            XCTAssertTrue(element.exists, "\(link) should render in the admin menu")
        }
    }

    // MARK: - Navigation on Tap

    /// Tapping Volunteers must push the volunteers screen — the assertion is
    /// on the destination's rendered state, not on the tap "not crashing".
    func testTapVolunteersNavigates() {
        navigateToAdminPanel()

        let link = scrollToVisible("admin-volunteers")
        XCTAssertTrue(link.isHittable, "Volunteers nav link should be on screen")
        link.tap()

        let arrived = anyElementExists([
            "volunteers-list", "volunteers-empty-state", "volunteers-loading",
        ])
        XCTAssertTrue(arrived, "Tapping Volunteers should show the volunteers screen")
    }

    /// Tapping Ban List must push the ban list screen.
    func testTapBansNavigates() {
        navigateToAdminPanel()

        let link = scrollToVisible("admin-bans")
        XCTAssertTrue(link.isHittable, "Ban List nav link should be on screen")
        link.tap()

        let arrived = anyElementExists([
            "ban-list", "bans-empty-state", "bans-loading",
        ])
        XCTAssertTrue(arrived, "Tapping Ban List should show the ban list screen")
    }

    /// Tapping Audit Log must push the audit log screen.
    func testTapAuditLogNavigates() {
        navigateToAdminPanel()

        let link = scrollToVisible("admin-audit-log")
        XCTAssertTrue(link.isHittable, "Audit Log nav link should be on screen")
        link.tap()

        let arrived = anyElementExists([
            "audit-log-list", "audit-empty-state", "audit-loading",
        ])
        XCTAssertTrue(arrived, "Tapping Audit Log should show the audit log screen")
    }

    /// Tapping Call Settings must push the call settings screen.
    func testTapCallSettingsNavigates() {
        navigateToAdminPanel()

        let link = scrollToVisible("admin-call-settings")
        XCTAssertTrue(link.isHittable, "Call Settings nav link should be on screen")
        link.tap()

        XCTAssertTrue(
            find("call-settings-view").waitForExistence(timeout: 10),
            "Tapping Call Settings should show the call settings screen"
        )
    }

    /// Tapping System Health — the last row of the menu, so reaching it also
    /// exercises scrolling to the bottom — must push the system health screen.
    func testTapSystemHealthNavigates() {
        navigateToAdminPanel()

        let link = scrollToVisible("admin-system-health", maxSwipes: 12)
        XCTAssertTrue(link.isHittable, "System Health nav link should be reachable at the bottom of the menu")
        link.tap()

        let arrived = anyElementExists([
            "system-health-view", "health-loading", "health-error-state",
        ])
        XCTAssertTrue(arrived, "Tapping System Health should show the system health screen")
    }
}
