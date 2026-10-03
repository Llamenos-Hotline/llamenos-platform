@desktop @ios @android
Feature: Dashboard
  As an authenticated volunteer or admin
  I want to see the dashboard with status cards, quick actions, and shift controls
  So that I can see my status at a glance and navigate to key features

  # ── Dashboard Display ─────────────────────────────────────────────

  @smoke
  Scenario: Dashboard displays all status cards
    Given I am authenticated and on the dashboard
    Then I should see the connection status card
    And I should see the shift status card
    And I should see the active calls card
    And I should see the recent notes card
    And I should see the identity card

  # @fixme: desktop dashboard has no identity card and v3 has no npub — #1313
  @smoke @fixme
  Scenario: Dashboard shows npub in identity card
    Given I am authenticated and on the dashboard
    Then the identity card should display my npub
    And the npub should start with "npub1"

  @smoke
  Scenario: Dashboard shows connection status
    Given I am authenticated and on the dashboard
    Then the connection card should show a status text
    And the top bar should show a connection dot

  @smoke
  Scenario: Dashboard shows shift status
    Given I am authenticated and on the dashboard
    Then the shift card should show "Off Shift" or "On Shift"
    And a clock in/out button should be visible

  @smoke
  Scenario: Dashboard shows active call count
    Given I am authenticated and on the dashboard
    Then the calls card should display a numeric call count
    And the count should be "0" for a fresh session

  @smoke
  Scenario: Dashboard shows recent notes section
    Given I am authenticated and on the dashboard
    Then the recent notes card should be displayed
    And either recent notes or "no recent notes" message should appear

  @regression
  Scenario: Dashboard lock button is present
    Given I am authenticated and on the dashboard
    Then the lock button should be visible in the top bar

  @regression
  Scenario: Dashboard logout button is present
    Given I am authenticated and on the dashboard
    Then the logout button should be visible in the top bar

  # ── Calls Today ───────────────────────────────────────────────────

  Scenario: Calls today count displayed on dashboard
    Given the app is launched
    Then I should see the calls today count on the dashboard

  Scenario: Calls today count updates with shift status
    Given the app is launched
    When I pull to refresh the dashboard
    Then I should see the calls today count on the dashboard

  # ── Dashboard Quick Actions ───────────────────────────────────────

  Scenario: Quick actions grid is visible
    Given I am authenticated and on the dashboard
    Then I should see the quick actions grid

  Scenario: All quick action cards are displayed
    Given I am authenticated and on the dashboard
    Then I should see the reports card on the dashboard
    And I should see the contacts card on the dashboard
    And I should see the blasts card on the dashboard
    And I should see the help card on the dashboard

  Scenario: Tapping reports card opens reports
    Given I am authenticated and on the dashboard
    When I tap the view reports button
    Then I should see the reports screen

  Scenario: Tapping contacts card opens contacts
    Given I am authenticated and on the dashboard
    When I tap the view contacts button
    Then I should see the contacts screen

  Scenario: Tapping blasts card opens blasts
    Given I am authenticated and on the dashboard
    When I tap the view blasts button
    Then I should see the blasts screen

  # ── Dashboard Blasts Navigation ───────────────────────────────────

  @android @desktop @regression
  Scenario: Dashboard shows blasts card
    Given I am authenticated and on the dashboard
    Then I should see the blasts card on the dashboard

  @android @desktop @regression
  Scenario: Navigate to blasts from dashboard
    Given I am authenticated and on the dashboard
    When I tap the view blasts button
    Then I should see the blasts screen

  @android @desktop @regression
  Scenario: Navigate back from blasts to dashboard
    Given I am authenticated and on the dashboard
    When I tap the view blasts button
    And I tap the back button on blasts
    Then I should see the dashboard

  # ── Dashboard Break Toggle ────────────────────────────────────────

  @regression
  Scenario: Break button is visible when on shift
    Given I am authenticated and on the main screen
    And the volunteer is on shift
    Then I should see the break toggle button

  @regression
  Scenario: Break banner appears when on break
    Given I am authenticated and on the main screen
    And the volunteer is on break
    Then I should see the on-break banner

  # ── Dashboard Error Handling ──────────────────────────────────────

  # @fixme: desktop dashboard has no error card, so "hidden" is vacuously true — #1313
  @regression @fixme
  Scenario: Error card is hidden by default
    Given I am authenticated and on the dashboard
    Then the dashboard error card should not be visible

  # @fixme: desktop dashboard has no error card to dismiss — #1313
  @regression @fixme
  Scenario: Error card can be dismissed
    Given I am authenticated and on the dashboard
    And a dashboard error is displayed
    When I dismiss the dashboard error
    Then the dashboard error card should not be visible

  # ── Dashboard Help Navigation ─────────────────────────────────────

  @regression
  Scenario: Dashboard shows help card
    Given I am on the dashboard
    Then I should see the help card

  @regression
  Scenario: Tapping help card navigates to help screen
    Given I am on the dashboard
    When I tap the help card
    Then I should see the help screen

  # ── Dashboard Shift Actions ───────────────────────────────────────

  @regression
  Scenario: Clock in button shows when off shift
    Given I am authenticated and on the dashboard
    And I am off shift
    Then the dashboard clock button should say "Clock In"

  @regression
  Scenario: Tapping clock in attempts to clock in
    Given I am authenticated and on the dashboard
    And I am off shift
    When I tap the dashboard clock button
    Then a clock-in request should be sent
    And the button should show a loading state briefly
