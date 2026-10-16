@ios @android
Feature: Reports
  As a volunteer, reporter, or admin
  I want to create, view, claim, and close reports
  So that community incidents are documented and tracked

  # ── Reports List ──────────────────────────────────────────────────

  @desktop @android @regression
  Scenario: Navigate to reports from dashboard
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    Then I should see the reports screen
    And I should see the reports title

  @desktop @android @regression
  Scenario: Reports screen displays status filter chips
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    Then I should see the "All" report status filter
    And I should see the "Active" report status filter
    And I should see the "Waiting" report status filter
    And I should see the "Closed" report status filter

  @desktop @android @regression
  Scenario: Reports shows list or empty state
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    Then I should see the reports content or empty state

  @desktop @android @regression
  Scenario: Navigate back from reports
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    And I tap the back button on reports
    Then I should see the dashboard

  @desktop @android @regression
  Scenario: Filter reports by active status
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    And I tap the "Active" report status filter
    Then the "Active" report status filter should be selected

  @desktop @android @regression
  Scenario: Filter reports by waiting status
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    And I tap the "Waiting" report status filter
    Then the "Waiting" report status filter should be selected

  @desktop @android @regression
  Scenario: Filter reports by closed status
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    And I tap the "Closed" report status filter
    Then the "Closed" report status filter should be selected

  @desktop @android @regression
  Scenario: Reset report filter to all
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    And I tap the "Active" report status filter
    And I tap the "All" report status filter
    Then the "All" report status filter should be selected

  @desktop @android @regression
  Scenario: Reports has pull to refresh
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    Then the reports screen should support pull to refresh

  @desktop @android @regression
  Scenario: Navigate back from reports returns to dashboard
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    Then I should see the reports title
    When I tap the back button on reports
    Then I should see the dashboard

  # ── Report Detail ─────────────────────────────────────────────────

  @desktop @android @regression
  Scenario: Report detail screen has title
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    And I tap the first report card
    Then I should see the report detail screen

  @desktop @android @regression
  Scenario: Report detail shows metadata card
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    And I tap the first report card
    Then I should see the report metadata card

  @desktop @android @regression
  Scenario: Report detail shows status badge
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    And I tap the first report card
    Then I should see the report status badge

  @desktop @android @regression
  Scenario: Navigate back from report detail
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    And I tap the first report card
    Then I should see the report detail screen
    When I tap the back button on report detail
    Then I should see the reports screen

  # ── Report Creation ───────────────────────────────────────────────

  @desktop @ios @android @regression
  Scenario: Create report FAB is visible
    Given I am authenticated and on the main screen
    And I navigate to the reports list
    Then I should see the create report button

  @desktop @ios @android @regression
  Scenario: Report creation form has required fields
    Given I am authenticated and on the main screen
    And I navigate to the report creation form
    Then I should see the report title input
    And I should see the report body input
    And I should see the report submit button

  @desktop @ios @android @regression
  Scenario: Submit button is disabled without title and body
    Given I am authenticated and on the main screen
    And I navigate to the report creation form
    Then the report submit button should be disabled

  # ── Report Claiming ───────────────────────────────────────────────

  @desktop @ios @android @regression
  Scenario: Claim button is visible on waiting report
    Given I am authenticated and on the main screen
    And I am viewing a report with status "waiting"
    Then I should see the report claim button

  @desktop @ios @android @regression
  Scenario: Claim button is not visible on closed report
    Given I am authenticated and on the main screen
    And I am viewing a report with status "closed"
    Then I should not see the report claim button

  # ── Report Closing ────────────────────────────────────────────────

  @desktop @ios @android @regression
  Scenario: Close button is visible on active report
    Given I am authenticated and on the main screen
    And I am viewing a report with status "active"
    Then I should see the report close button

  @desktop @ios @android @regression
  Scenario: Close button is not visible on waiting report
    Given I am authenticated and on the main screen
    And I am viewing a report with status "waiting"
    Then I should not see the report close button

  @desktop @ios @android @regression
  Scenario: Close button is not visible on already closed report
    Given I am authenticated and on the main screen
    And I am viewing a report with status "closed"
    Then I should not see the report close button

  # ── Admin: Reports Page ───────────────────────────────────────────

  @desktop @ios @android
  Scenario: Reports page loads with heading
    Given I am logged in as an admin
    When I navigate to the "Reports" page
    Then I should see the "Reports" heading

  @desktop @ios @android
  Scenario: Create a report via admin
    Given I am logged in as an admin
    When I navigate to the "Reports" page
    And I click "New Report"
    And I fill in the report details
    And I click "Submit"
    Then the report should appear in the reports list

  @desktop @ios @android
  Scenario: Report list displays
    Given I am logged in as an admin
    And at least one report exists
    When I navigate to the "Reports" page
    Then I should see reports in the list

  @desktop @ios @android
  Scenario: Report detail view
    Given I am logged in as an admin
    And a report exists
    When I click on the report
    Then I should see the report detail view
    And I should see the report content

  @desktop @ios @android
  Scenario: Reporter can create reports
    Given I am logged in as an admin
    And a reporter has been invited and onboarded
    When the reporter logs in
    And they navigate to the "Reports" page
    And they create a new report
    Then the report should be saved successfully

  @desktop @ios @android
  Scenario: Reporter cannot access admin pages
    Given I am logged in as an admin
    And a reporter is logged in
    When they navigate to "/users" via SPA
    Then they should see "Access Denied"

  # ── Template-Driven Report Types ─────────────────────────────────────

  # Mobile-only: these assert a tap-to-open report-type picker with an
  # audio input button on the arrestee details field — a mobile UI pattern
  # that has no desktop equivalent. Desktop's analogous behavior (tabs +
  # dynamic schema fields in the create dialog) is covered separately below
  # under "Desktop: Template-Driven Report Types". Real @android step
  # definitions exist (apps/android/.../steps/reports/ReportTypeSteps.kt);
  # these were only ever @wip because the feature-level @desktop tag used
  # to leak onto them with no desktop steps to match — #1195.
  @android
  Scenario: Report type picker shows mobile-optimized types
    Given the "jail-support" template is applied
    When I tap the create report button
    Then the report type picker should show available types
    And each type card should show a label and description

  @android
  Scenario: Template-driven report form renders dynamic fields
    Given the "jail-support" template is applied
    And I select report type "LO Arrest Report"
    Then I should see fields for location, time, and arrestee details
    And the arrestee details field should have an audio input button

  @android
  Scenario: Submit a template-driven report
    Given I fill in the template report form
    When I tap the submit button
    Then a success message should appear
    And the report should appear in my reports list

  # ── Desktop: Template-Driven Report Types ──────────────────────────────

  # @fixme: the Reports page reads global report types, not template-defined ones — #1309
  @desktop @fixme
  Scenario: Template apply creates report types
    Given I am logged in as an admin
    And case management is enabled
    And the "jail-support" template has been applied
    When I navigate to the "Reports" page
    Then I should see the report type tabs
    And the report type tabs should include template-defined types

  @desktop
  Scenario: Report type selector shows template types in create dialog
    Given I am logged in as an admin
    And case management is enabled
    And the "jail-support" template has been applied
    When I navigate to the "Reports" page
    And I click "New Report"
    Then the report type selector should be visible
    And the report type selector should list template-defined types

  # @fixme: the Reports page reads global report types, not template-defined ones — #1309
  @desktop @fixme
  Scenario: Template-driven report form shows schema fields
    Given I am logged in as an admin
    And case management is enabled
    And the "jail-support" template has been applied
    When I navigate to the "Reports" page
    And I click "New Report"
    And I select the first template report type
    Then the report form should show dynamic schema fields

  @desktop
  Scenario: Submit a template-driven report via desktop
    Given I am logged in as an admin
    And case management is enabled
    And the "jail-support" template has been applied
    When I navigate to the "Reports" page
    And I click "New Report"
    And I select the first template report type
    And I fill in the required report fields
    And I click "Submit Report"
    Then a success toast should appear
    And the submitted report should appear in the list
