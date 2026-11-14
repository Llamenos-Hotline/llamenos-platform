@backend @lifecycle
Feature: State Transition Validation
  Verify that real-time state changes (bans, shifts, conversation status)
  take effect immediately and produce correct routing and status outcomes.

  # ─── Ban/Unban Affects Routing ───────────────────────────────────────

  Scenario Outline: Ban and unban affect call routing in real-time
    Given 1 volunteers are on shift
    When an admin bans "<phone>"
    And an incoming call arrives from "<phone>"
    Then the banned call should be rejected
    When the admin removes the ban for "<phone>"
    And an incoming call arrives from "<phone>"
    Then the call should be ringing

    Examples:
      | phone          |
      | +15550100001   |
      | +15550100002   |
      | +15550100003   |

  # Removing a volunteer from the shift is asserted against the next call's real ring set
  # in signed-call-routing.feature (#1052).

  # ─── Report Conversion Idempotency ──────────────────────────────────

  Scenario: Report conversion is idempotent
    Given a reporter exists for conversion testing
    When the reporter submits a report for conversion
    And the admin converts the submitted report to a case
    And the admin converts the submitted report to a case again
    Then the submitted report should still have exactly one linked case

  # ─── Conversation Status Transitions ─────────────────────────────────

  Scenario: Conversation status transitions — waiting to active to closed to reopened
    Given 1 volunteers are on shift
    When an SMS arrives from "+15550200001" with body "Need help"
    Then a conversation should have been created
    When the volunteer claims the conversation
    Then the conversation status should be "active"
    When the admin closes the conversation
    Then the conversation status should be "closed"
    When another SMS arrives from "+15550200001" with body "Still need help"
    Then the conversation should be reopened
