@ios
Feature: Role Viewer (Mobile)
  Admins view hub roles with their effective permissions and assigned-user
  counts, mirroring the desktop hub-roles-section. Role names are E2EE —
  decrypted client-side from per-admin HPKE envelopes — and role data comes
  from the generated protocol types (GET /api/settings/roles).
  Members' effective permissions (union of their role assignments) are visible
  from the Volunteers screen via GET /api/settings/users/:id/effective-permissions.

  Background:
    Given the app is launched and authenticated as admin

  @ios @regression
  Scenario: Role viewer lists roles with permission and user counts
    When I navigate to the Roles admin screen
    Then I should see the roles list
    And each role row should show a permission count
    And each role row should show an assigned user count

  @ios @regression
  Scenario: Role viewer shows system and default badges
    When I navigate to the Roles admin screen
    Then system roles should show a System badge
    And the default role should show a Default badge

  @ios @regression
  Scenario: Role detail shows permissions grouped by domain
    When I navigate to the Roles admin screen
    And I tap the first role
    Then I should see the role detail view
    And I should see the role's permissions grouped by domain

  @ios @regression
  Scenario: User row opens effective permissions for admins
    When I navigate to the Volunteers admin screen
    And I tap the effective permissions button on a user row
    Then I should see the user's effective permissions list

  @ios @regression
  Scenario: Role viewer is hidden without the view roles permission
    Given the app is launched and authenticated as volunteer
    When I open the main tab view
    Then the Roles admin screen should not be reachable
