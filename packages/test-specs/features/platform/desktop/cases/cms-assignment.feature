@desktop
Feature: Smart Case Assignment & Routing
  Admins assign cases to volunteers with intelligent suggestions
  based on availability, workload, specialization, and language.

  Background:
    Given I am logged in as an admin
    And case management is enabled
    And the "jail-support" template has been applied
    And volunteers with different profiles exist

  # --- Assignment suggestion API ---

  Scenario: Suggest assignees returns ranked volunteers
    Given an unassigned arrest case exists
    And on-shift volunteers with capacity exist
    When I request assignment suggestions for the case
    Then the response should contain suggested volunteers
    And each suggestion should include a score and reasons

  # @wip: the desktop step bodies were empty; backend BDD covers this — #1298
  @wip
  Scenario: Suggestions exclude volunteers on break
    Given an unassigned arrest case exists
    And a volunteer is on break
    When I request assignment suggestions for the case
    Then the on-break volunteer should not appear in suggestions

  # @wip: the desktop step bodies were empty; backend BDD covers this — #1298
  @wip
  Scenario: Suggestions exclude volunteers at capacity
    Given an unassigned arrest case exists
    And a volunteer has reached their max case assignments
    When I request assignment suggestions for the case
    Then the at-capacity volunteer should not appear in suggestions

  # @wip: the desktop step bodies were empty; backend BDD covers this — #1298
  @wip
  Scenario: Language match boosts suggestion score
    Given an arrest case with a Spanish-speaking contact exists
    And a volunteer speaks Spanish
    When I request assignment suggestions for the case
    Then the Spanish-speaking volunteer should rank higher

  # @wip: the desktop step bodies were empty; backend BDD covers this — #1298
  @wip
  Scenario: Workload balance favors least-loaded volunteers
    Given an unassigned arrest case exists
    And volunteer A has 2 active cases
    And volunteer B has 8 active cases
    When I request assignment suggestions for the case
    Then volunteer A should rank higher than volunteer B

  # --- Assignment UI ---

  Scenario: Assignment dialog shows suggested volunteers
    Given an unassigned arrest case exists
    When I navigate to the "Cases" page
    And I click the first case card
    And I click the "Assign" button
    Then the assignment dialog should be visible
    And suggested volunteers should appear at the top
    And each volunteer should show a workload indicator

  # @fixme: the assignment dialog renders no suggestion reasons — #1310
  @fixme
  Scenario: Assignment dialog shows match reasons
    Given an unassigned arrest case exists
    When I open the assignment dialog for the case
    Then each suggested volunteer should show match reasons
    And reasons should include availability and workload

  Scenario: Assign a case to a suggested volunteer
    Given an unassigned arrest case exists
    When I open the assignment dialog for the case
    And I click assign on the first suggested volunteer
    Then a success toast should appear
    And the case should show the volunteer as assigned

  Scenario: Unassign a volunteer from a case
    Given a case assigned to a volunteer exists
    When I navigate to the "Cases" page
    And I click the first case card
    And I click the "Unassign" button
    Then a success toast should appear
    And the assign button should reappear

  # --- Auto-assignment ---

  Scenario: Enable auto-assignment for new cases
    When I navigate to the "Cases" page
    And I toggle the auto-assignment switch
    Then the auto-assignment indicator should be visible
    And a success toast should appear

  # @fixme: the hub auto-assign toggle is never read at case creation — #1306
  @fixme
  Scenario: Auto-assigned case shows assignment immediately
    Given auto-assignment is enabled
    When a new arrest case is created via API
    And I navigate to the "Cases" page
    Then the new case should have an assignee
