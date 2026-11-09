@backend
Feature: A hub's shifts are written in the hub's time zone
  A shift's start time, end time and weekdays are wall-clock values in the IANA time
  zone of the hub it belongs to (#1054). The server evaluates them against that zone's
  own clock, so a 09:00-17:00 shift rings at 09:00-17:00 where the hub is, in summer and
  in winter, and not at 09:00-17:00 UTC.

  # The server's clock is real, so each scenario builds its window from "now" in the zone
  # under test rather than pretending a time. New York is 4-5 hours behind UTC all year,
  # so a window an hour either side of now in one zone can never contain now in the other:
  # if the server ignores the zone, exactly these two scenarios fail. The daylight-saving
  # transitions themselves cannot be reached through a live clock; they are pinned against
  # fixed instants in apps/worker/__tests__/unit/shifts.test.ts and
  # apps/worker/__tests__/integration-bun/hub-timezone.test.ts.

  Scenario: Shift time zone is respected
    Given a hub in the "America/New_York" time zone
    And a volunteer is clocked in on a shift covering the current time in "America/New_York"
    When a call is routed to that hub
    Then the call should ring

  Scenario: A shift written for another zone's clock does not ring
    Given a hub in the "America/New_York" time zone
    And a volunteer is clocked in on a shift covering the current time in "UTC"
    When a call is routed to that hub
    Then the call should be refused because nobody is on shift
