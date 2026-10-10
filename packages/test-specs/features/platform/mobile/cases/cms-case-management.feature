Feature: Case Management (Mobile)
  Users view and manage CMS cases on mobile devices.
  Case list shows template-driven entity type tabs, status filters,
  and navigates to detail views with timeline, contacts, and evidence.

  # Platform tags live at scenario level, not feature level: Gherkin and the
  # coverage validator both UNION feature and scenario tags, so a feature-level
  # `@ios @android` would force every scenario onto both platforms. Each
  # scenario here is tagged for the platform(s) that actually implement it
  # (same convention as core/hub-management.feature).

  Background:
    Given the app is launched and authenticated as admin

  @android
  Scenario: Case list shows entity type tabs
    When I navigate to the Cases screen
    Then I should see the entity type tabs
    And the "All" tab should be active

  @ios
  Scenario: Selecting entity type shows matching case
    Given case management is enabled with two entity types
    And a case exists
    When I navigate to the Cases screen
    Then selecting Arrest Case should keep its case in the filtered list

  @ios @android
  Scenario: Case list shows case cards with status badges
    Given cases exist in the system
    When I navigate to the Cases screen
    Then I should see at least one case card
    And each case card should show a status badge

  @ios @android
  Scenario: Entity type tab filters the case list
    Given cases of different entity types exist
    When I navigate to the Cases screen
    And I tap an entity type tab
    Then the case list should update

  @ios @android
  Scenario: Tapping a case card opens the detail view
    Given cases exist in the system
    When I navigate to the Cases screen
    And I tap the first case card
    Then I should see the case detail header
    And I should see the status pill
    And I should see the detail tab bar

  @ios @android
  Scenario: Case detail shows all four tabs
    Given a case detail is open
    Then I should see the Details tab
    And I should see the Timeline tab
    And I should see the Contacts tab
    And I should see the Evidence tab

  @ios @android
  Scenario: Timeline tab shows interaction history
    Given a case with interactions is open
    When I tap the Timeline tab
    Then I should see timeline items
    And each timeline item should show type and timestamp

  @ios @android
  Scenario: Status pill opens the status picker
    Given a case detail is open
    When I tap the status pill
    Then the status picker sheet should appear
    And status options should be listed

  @ios @android
  Scenario: Changing status updates the case
    Given a case detail is open
    When I tap the status pill
    And I select a different status
    Then the status pill should reflect the new status

  @ios @android
  Scenario: Adding a comment to the timeline
    Given a case detail is open
    When I tap the comment input
    And I type "Test comment from BDD"
    And I submit the comment
    Then the timeline should update with the new comment

  @ios @android
  Scenario: Assign to me button works for unassigned cases
    Given an unassigned case detail is open
    Then I should see the assign to me button
    When I tap the assign to me button
    Then the case should be assigned to me
