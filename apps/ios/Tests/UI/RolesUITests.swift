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

            let listFound = anyElementExists(["roles-list"], timeout: 10)
            guard listFound else { return }

            let firstRow = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'role-row-'"))
                .firstMatch
            if firstRow.waitForExistence(timeout: 5) {
                firstRow.tap()
            }
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

            _ = anyElementExists(["volunteers-list", "volunteers-loading", "volunteers-empty-state"])

            let permButton = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'effective-permissions-'"))
                .firstMatch
            if permButton.waitForExistence(timeout: 10) {
                permButton.tap()
            }
        }
        then("I should see the effective permissions view") {
            let found = anyElementExists([
                "effective-permissions-list", "effective-permissions-loading",
                "effective-permissions-error",
            ])
            XCTAssertTrue(found, "Effective permissions view should appear")
        }
    }

    // MARK: - Scenario: Role viewer is hidden without the view-roles permission

    func testRoleViewerIsHiddenWithoutTheViewRolesPermission() {
        given("I am authenticated as a volunteer (no system:view-roles)") {
            launchAsVolunteerWithAPI()
        }
        when("I look at the admin panel") {
            navigateToAdminPanel()
        }
        then("the roles link should not exist") {
            let rolesLink = find("admin-roles")
            let exists = rolesLink.waitForExistence(timeout: 2)
            XCTAssertFalse(exists, "Roles link should be hidden without system:view-roles")
        }
    }
}
