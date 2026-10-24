@backend
Feature: Being scheduled is not being a ring target
  Ringing needs the admin's schedule AND the volunteer's own clock-in. A client
  that shows "ready for calls" from the schedule alone tells a volunteer they are
  on duty while the server rings nobody (#2108), so the server must report both
  facts separately and ring only when both hold.

  Background:
    Given a volunteer is scheduled on shift now

  Scenario: A scheduled volunteer who has not clocked in is reported as not clocked in
    When the scheduled volunteer reads their shift status
    Then the shift status says they are on shift
    And the shift status says they are not clocked in

  Scenario: A scheduled volunteer who has not clocked in is not a ring target
    Then the scheduled volunteer is not a ring target

  Scenario: Clocking in makes the scheduled volunteer a ring target
    Given the scheduled volunteer clocks in
    When the scheduled volunteer reads their shift status
    Then the shift status says they are on shift
    And the shift status says they are clocked in
    And the scheduled volunteer is a ring target

  Scenario: Clocking out stops the ringing
    Given the scheduled volunteer clocks in
    And the scheduled volunteer clocks out
    When the scheduled volunteer reads their shift status
    Then the shift status says they are not clocked in
    And the scheduled volunteer is not a ring target
