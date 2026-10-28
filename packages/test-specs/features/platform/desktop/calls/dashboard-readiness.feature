@desktop
Feature: Dashboard readiness matches the server's ring decision
  As a volunteer
  I want the dashboard to tell me whether calls will actually ring me
  So that I never sit "ready" while the server rings nobody (#2108)

  # ── Dashboard readiness is the server's ring decision (#2108) ─────
  # Ringing needs scheduled-now AND clocked-in. A card that read "Ready for
  # calls" from the schedule alone told volunteers they were on duty while the
  # server rang nobody, and there was no control that could change it.

  @regression
  Scenario: A scheduled volunteer who has not clocked in is not told they are ready
    Given I am logged in as a volunteer on shift
    Then the shift card should say "Not clocked in"
    And the shift card should not say "Ready for calls"
    And the volunteer is not a ring target

  @regression
  Scenario: Clocking in from the dashboard makes the volunteer a ring target
    Given I am logged in as a volunteer on shift
    When I tap the dashboard clock button
    Then the shift card should say "Ready for calls"
    And the volunteer is a ring target

  @regression
  Scenario: Clocking out from the dashboard stops the ringing
    Given I am logged in as a volunteer on shift
    And I am on shift
    When I tap the dashboard clock button
    Then the shift card should say "Not clocked in"
    And the volunteer is not a ring target

  @regression
  Scenario: Taking a break is separate from clocking out
    Given I am logged in as a volunteer on shift
    And I am on shift
    When they tap the break button
    Then the shift card should say "On Break"
    And the dashboard clock button should say "Clock Out"
    And the volunteer is not a ring target
