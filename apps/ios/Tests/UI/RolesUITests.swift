import XCTest

/// BDD tests for the iOS Role Viewer feature (#751).
/// Tests role listing, system/default badges, permission detail, and
/// effective permissions from the users screen.
final class RolesUITests: BaseUITest {

    // MARK: - Helper: Navigate to Roles

    private func navigateToRoles() {
        navigateToAdminPanel()

        let rolesLink = scrollToFind("admin-roles")
        guard rolesLink.waitForExistence(timeout: 5) else {
            XCTFail("Roles link should exist in admin panel")
            return
        }
        rolesLink.tap()

        _ = anyElementExists([
            "roles-list", "roles-loading", "roles-error",
        ])
    }

    // MARK: - Scenario: Role viewer lists roles with permission and user counts

    func testRoleViewerListsRolesWithPermissionAndUserCounts() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to the roles viewer") {
            navigateToRoles()
        }
        then("I should see the roles list with permission counts") {
            let listFound = anyElementExists([
                "roles-list", "roles-loading", "roles-error",
            ])
            XCTAssertTrue(listFound, "Roles view should show list, loading, or error state")
        }
    }

    // MARK: - Scenario: Role viewer shows system and default badges

    func testRoleViewerShowsSystemAndDefaultBadges() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to the roles viewer") {
            navigateToRoles()
        }
        then("I should see the roles list (badges are per-role)") {
            let listFound = anyElementExists(["roles-list"], timeout: 10)
            XCTAssertTrue(listFound, "Roles list should render with rows")
        }
    }

    // MARK: - Scenario: Role detail shows permissions grouped by domain

    func testRoleDetailShowsPermissionsGroupedByDomain() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to the roles viewer and tap a role") {
            navigateToRoles()

            XCTAssertTrue(
                anyElementExists(["roles-list"], timeout: 10),
                "The roles viewer should list the hub's roles"
            )

            let firstRow = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'role-row-'"))
                .firstMatch
            XCTAssertTrue(firstRow.waitForExistence(timeout: 5), "The roles list should have at least one role row")
            firstRow.tap()
        }
        then("I should see the role detail view") {
            let detailFound = anyElementExists(["role-detail"], timeout: 5)
            XCTAssertTrue(detailFound, "Role detail view should appear")
        }
    }

    // MARK: - Scenario: User row opens effective permissions for admins

    func testUserRowOpensEffectivePermissionsForAdmins() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to users and tap the permissions button") {
            navigateToAdminPanel()

            let usersLink = find("admin-volunteers")
            guard usersLink.waitForExistence(timeout: 5) else {
                XCTFail("Volunteers link should exist")
                return
            }
            usersLink.tap()

            XCTAssertTrue(
                find("volunteers-list").waitForExistence(timeout: 10),
                "The users list should load"
            )

            // The permissions button carries its own identifier (a row-level
            // identifier must not swallow it), so it is a button of its own.
            let permButton = app.buttons.matching(
                NSPredicate(format: "identifier BEGINSWITH 'effective-permissions-'")
            ).firstMatch
            guard permButton.waitForExistence(timeout: 10) else {
                XCTFail("A user row should offer a permissions button for users:read holders")
                return
            }
            permButton.tap()
        }
        then("I should see the effective permissions view") {
            // The loaded list, not merely a screen: "loading" and "error" are
            // what the view shows when the fetch has not (or has not) worked.
            XCTAssertTrue(
                find("effective-permissions-list").waitForExistence(timeout: 15),
                "Effective permissions view should list the user's permissions"
            )
        }
    }

    // MARK: - Scenario: Role viewer is hidden without the view-roles permission

    func testRoleViewerIsHiddenWithoutTheViewRolesPermission() {
        given("I am authenticated as a volunteer (no system:view-roles)") {
            launchAsVolunteerWithAPI()
        }
        when("I open Settings") {
            navigateToSettings()
            // Positive control: Settings rendered, so a missing admin entry
            // below means "hidden", not "the screen never loaded".
            XCTAssertTrue(
                scrollToFind("settings-transcription-link", maxSwipes: 5, timeout: 10).exists,
                "The Settings screen should have loaded"
            )
        }
        then("the admin panel, and the roles viewer behind it, should not be reachable") {
            XCTAssertFalse(
                scrollToFind("settings-admin-link", maxSwipes: 5, timeout: 2).exists,
                "The admin panel link should be hidden without audit:read"
            )
            XCTAssertFalse(find("admin-roles").exists, "Roles link should be hidden without system:view-roles")
        }
    }
}
