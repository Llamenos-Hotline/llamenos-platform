@desktop
Feature: CMS Triage Queue
  Admins triage incoming reports by reviewing encrypted content,
  creating linked case records, and tracking conversion progress.

  Background:
    Given I am logged in as an admin
    And case management is enabled
    And the "rapid-response" template has been applied

  @triage
  Scenario: Triage page loads with correct title
    Given a CMS report type with case conversion exists
    And a triage-eligible report exists
    When I navigate to the "Triage" page
    Then I should see the "Triage" page title

  @triage
  Scenario: Status tabs filter the triage queue
    Given a CMS report type with case conversion exists
    And a triage-eligible report exists
    When I navigate to the "Triage" page
    Then the pending status tab should be active
    When I click the "In Progress" status tab
    Then the in progress status tab should be active

  # @fixme: the seeded report never appears in the triage queue — #1206
  @triage @fixme
  Scenario: Selecting a report shows its content
    Given a CMS report type with case conversion exists
    And a triage-eligible report exists
    When I navigate to the "Triage" page
    And I click the first triage report card
    Then the triage report content should be visible
    And the report type label should be visible

  # @fixme: the seeded report never appears in the triage queue — #1206
  @triage @fixme
  Scenario: Create case from report via inline panel
    Given a CMS report type with case conversion exists
    And a triage-eligible report exists
    When I navigate to the "Triage" page
    And I click the first triage report card
    Then the triage case creation panel should be visible
    When I fill in the triage case title
    And I click the triage create case button
    Then a toast "Case created" should appear
    And the linked cases section should show at least one case

  # @fixme: the seeded report never appears in the triage queue — #1206
  @triage @fixme
  Scenario: Mark report as in progress
    Given a CMS report type with case conversion exists
    And a triage-eligible report exists
    When I navigate to the "Triage" page
    And I click the first triage report card
    And I click the mark in progress button
    Then a toast "Status updated" should appear

  # @fixme: the seeded report never appears in the triage queue — #1206
  @triage @fixme
  Scenario: Mark report as completed
    Given a CMS report type with case conversion exists
    And a triage-eligible report exists
    When I navigate to the "Triage" page
    And I click the first triage report card
    And I click the mark completed button
    Then a toast "Status updated" should appear

  @triage
  Scenario: Empty triage queue shows placeholder
    When I navigate to the "Triage" page
    Then the triage queue should show the no reports message

  @triage
  Scenario: Triage nav link visible for admin
    When I look at the navigation sidebar
    Then the "Triage" nav link should be visible

  # @fixme: the seeded report never appears in the triage queue — #1206
  @triage @fixme
  Scenario: Linked cases update after case creation
    Given a CMS report type with case conversion exists
    And a triage-eligible report with a linked case exists
    When I navigate to the "Triage" page
    And I click the first triage report card
    Then the linked cases section should show at least one case
