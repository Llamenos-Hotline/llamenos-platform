@desktop @ios @android
Feature: Volunteer Lifecycle
  As an admin
  I want to manage volunteers through their lifecycle
  So that I can control who answers calls and their access levels

  # ── Desktop/Mobile: Volunteer CRUD ────────────────────────────────

  @desktop @ios @android
  Scenario: Volunteer can login after admin creates account
    Given I am logged in as an admin
    And an admin has created a volunteer
    When the volunteer logs in with their device key
    Then they should see the dashboard or profile setup

  @desktop @ios @android
  Scenario: Volunteer completes profile setup
    Given I am logged in as an admin
    And a volunteer has logged in
    When they complete the profile setup
    Then they should see the dashboard

  @desktop @ios @android
  Scenario: Volunteer sees limited navigation
    Given I am logged in as an admin
    And a volunteer is logged in and on the dashboard
    Then they should see "Dashboard" in the navigation
    And they should see "Notes" in the navigation
    And they should see "Settings" in the navigation
    But they should not see "Volunteers" in the navigation
    And they should not see "Shifts" in the navigation
    And they should not see "Ban List" in the navigation

  @desktop @ios @android
  Scenario: Volunteer can toggle on-break status
    Given I am logged in as an admin
    And a volunteer is logged in and on the dashboard
    When they tap the break button
    Then they should see "On Break"

  @desktop @ios @android
  Scenario: Volunteer cannot access admin pages via URL
    Given I am logged in as an admin
    And a volunteer is logged in and on the dashboard
    When they navigate to "/users" via SPA
    Then they should see "Access Denied"

  @desktop @ios @android
  Scenario: Volunteer cannot access shifts page via URL
    Given I am logged in as an admin
    And a volunteer is logged in and on the dashboard
    When they navigate to "/shifts" via SPA
    Then they should see "Access Denied"

  @desktop @ios @android
  Scenario: Volunteer cannot access bans page via URL
    Given I am logged in as an admin
    And a volunteer is logged in and on the dashboard
    When they navigate to "/bans" via SPA
    Then they should see "Access Denied"

  @desktop @ios @android
  Scenario: Volunteer can navigate to notes
    Given I am logged in as an admin
    And a volunteer is logged in and on the dashboard
    When they click the "Notes" link
    Then they should see the "Call Notes" heading

  @desktop @ios @android
  Scenario: Volunteer can navigate to settings
    Given I am logged in as an admin
    And a volunteer is logged in and on the dashboard
    When they click the "Settings" link
    Then they should see the "Settings" heading
    And they should not see "Spam Mitigation"

  # ── Desktop/Mobile: Volunteer Profile ─────────────────────────────

  @desktop @ios @android
  Scenario: Navigate to volunteer profile from list
    Given I am logged in as an admin
    And I have created a volunteer
    And I navigate to the "Volunteers" page
    When I tap a volunteer card
    Then I should see the volunteer detail screen

  @desktop @ios @android
  Scenario: Profile card shows volunteer information
    Given I am logged in as an admin
    And I have created a volunteer
    And I navigate to the "Volunteers" page
    When I tap a volunteer card
    Then I should see the volunteer name

  @desktop @ios @android
  Scenario: Profile card shows join date
    Given I am logged in as an admin
    And I have created a volunteer
    And I navigate to the "Volunteers" page
    When I tap a volunteer card
    Then I should see the volunteer join date

  @desktop @ios @android
  Scenario: Recent activity section is displayed
    Given I am logged in as an admin
    And I have created a volunteer
    And I navigate to the "Volunteers" page
    When I tap a volunteer card
    Then I should see the recent activity card

  @desktop @ios @android
  Scenario: Navigate back from volunteer profile
    Given I am logged in as an admin
    And I have created a volunteer
    And I navigate to the "Volunteers" page
    When I tap a volunteer card
    And I tap the back button on the volunteer detail
    Then I should see the "Volunteers" heading

  # ── Desktop/Mobile: Role Management ───────────────────────────────

  @desktop @ios @android
  Scenario: List default roles
    Given I am logged in as an admin
    When I request the roles list
    Then I should see at least 5 roles
    And I should see "Super Admin" role
    And I should see "Hub Admin" role
    And I should see "Reviewer" role
    And I should see "Volunteer" role
    And I should see "Reporter" role

  @desktop @ios @android
  Scenario: Super Admin has wildcard permission
    Given I am logged in as an admin
    When I request the roles list
    Then the "Super Admin" role should have wildcard permission
    And the "Super Admin" role should be a system role
    And the "Super Admin" role should be the default role

  @desktop @ios @android
  Scenario: Create a custom role
    Given I am logged in as an admin
    When I create a custom role "Call Monitor" with permissions
    Then the role should be created successfully
    And the role slug should be "call-monitor"

  @desktop @ios @android
  Scenario: Delete a custom role
    Given I am logged in as an admin
    And a custom role "Temp Role" exists
    When I delete the "Temp Role" role
    Then the role should be removed

  @desktop @ios @android
  Scenario: Cannot delete system roles
    Given I am logged in as an admin
    When I attempt to delete the "Super Admin" role
    Then the deletion should fail with a 403 error

  @desktop @ios @android
  Scenario: Assign role to volunteer
    Given I am logged in as an admin
    And a volunteer exists
    When I assign the "Reviewer" role to the volunteer
    Then the volunteer should have the "Reviewer" role

  @desktop @ios @android
  Scenario: Volunteer with Reviewer role can access notes
    Given I am logged in as an admin
    And a volunteer with the "Reviewer" role exists
    When the reviewer logs in
    Then they should see "Notes" in the navigation

  @desktop @ios @android
  Scenario: Reporter role has limited permissions
    Given I am logged in as an admin
    When I request the "Reporter" role details
    Then it should have "reports:create" permission
    And it should not have "notes:read" permission

  @desktop @ios @android
  Scenario: Reject duplicate role slug
    Given I am logged in as an admin
    When I create a custom role with an existing slug
    Then I should see a duplicate slug error

  @desktop @ios @android
  Scenario: Reject invalid slug format
    Given I am logged in as an admin
    When I create a role with slug "Invalid Slug!"
    Then I should see an invalid slug error

  @desktop @ios @android
  Scenario: Update custom role permissions
    Given I am logged in as an admin
    And a custom role "Call Monitor" exists
    When I update the role permissions
    Then the permissions should be updated

  @desktop @ios @android
  Scenario: Fetch permissions catalog
    Given I am logged in as an admin
    When I request the permissions catalog
    Then I should see all available permissions grouped by domain

  @desktop @ios @android
  Scenario: Admin can access all endpoints
    Given I am logged in as an admin
    Then I should have access to all API endpoints

  @desktop @ios @android
  Scenario: Volunteer cannot access admin endpoints
    Given I am logged in as a volunteer
    When I attempt to access an admin endpoint
    Then I should receive a 403 forbidden response

  @desktop @ios @android
  Scenario: Reporter cannot access call endpoints
    Given I am logged in as a reporter
    When I attempt to access call-related endpoints
    Then I should receive a 403 forbidden response

  @desktop @ios @android
  Scenario: Multi-role user gets union of permissions via UI
    Given I am logged in as an admin
    And a volunteer has both "Volunteer" and "Reviewer" roles
    When the volunteer logs in
    Then they should have permissions from both roles

  @desktop @ios @android
  Scenario: Custom role grants only specified permissions via UI
    Given I am logged in as an admin
    And a volunteer has only a custom "Call Monitor" role
    When the volunteer logs in
    Then they should only see endpoints allowed by that role

  @desktop @ios @android
  Scenario: Custom role user cannot access unauthorized endpoints
    Given I am logged in as an admin
    And a volunteer has only a custom "Call Monitor" role
    When the volunteer attempts to access an unauthorized endpoint
    Then they should receive a 403 forbidden response

  @desktop @ios @android
  Scenario: Reporter sees reports UI only
    Given I am logged in as a reporter
    Then I should see the reports navigation
    And I should not see the calls navigation
    And I should not see the volunteers management

  @desktop @ios @android
  Scenario: Admin sees all navigation items
    Given I am logged in as an admin
    Then I should see all navigation items including admin

  @desktop @ios @android
  Scenario: Domain wildcard grants all domain permissions
    Given I am logged in as an admin
    And a role with "notes:*" wildcard permission
    When the user with that role logs in
    Then they should have all notes-related permissions

  @desktop @ios @android
  Scenario: Role selector shows all default roles
    Given I am logged in as an admin
    When I view the volunteer list
    Then the role dropdown should show all default roles

  @desktop @ios @android
  Scenario: Change volunteer role via dropdown
    Given I am logged in as an admin
    And a volunteer with "Volunteer" role
    When I change their role to "Hub Admin" via the dropdown
    Then the volunteer should display the "Hub Admin" badge

  @desktop @ios @android
  Scenario: Hub Admin badge displays after role change
    Given I am logged in as an admin
    And I changed a volunteer's role to "Hub Admin"
    Then I should see the "Hub Admin" badge on their card

  @desktop @ios @android
  Scenario: Invite form shows available roles
    Given I am logged in as an admin
    When I open the Invite form
    Then I should see all available roles in the form

  @desktop @ios @android
  Scenario: Delete non-existent role returns error
    Given I am logged in as an admin
    When I attempt to delete a role that does not exist
    Then I should receive a not found error

  # ── Backend: Shift Status Query ─────────────────────────────────

  @backend @desktop
  Scenario: Dashboard shows correct on-shift volunteer count
    And 3 volunteers are on shift
    When I query the shift status
    Then 3 volunteers are reported as on-shift
