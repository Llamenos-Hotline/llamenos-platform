@backend @lifecycle
Feature: Call Lifecycle Workflows
  Verify the complete lifecycle of calls from ring through completion,
  including note creation, history tracking, and multi-volunteer interactions.

  # ─── Full Lifecycle ──────────────────────────────────────────────────

  Scenario: Full call lifecycle — ring, answer, note, end, history
    Given 2 volunteers are on shift
    When a call arrives from a unique caller
    Then the call status is "ringing"
    When volunteer 1 answers the call
    Then the call status is "in-progress"
    When the answering volunteer creates a note for the call
    And the call is ended
    Then the call status is "completed"
    And the call history contains 1 entry
    And the most recent call shows status "completed"
    And the answering volunteer can see the note
    And the admin can see the note
    And the other volunteer cannot see the note

  # ─── Ban Mid-Call ────────────────────────────────────────────────────

  Scenario: Ban mid-call disconnects caller and blocks future calls
    Given 1 volunteers are on shift
    And volunteer 0 is on an active call with a unique caller
    When volunteer 0 bans and hangs up the call
    Then the response should indicate the caller was banned
    And the caller should be in the ban list
    When the same caller tries to call again
    Then the call should be rejected

  # ─── Volunteer Removal Affects Routing ───────────────────────────────

  Scenario: Volunteer removed from shift stops ringing on next call
    Given 2 volunteers are on shift
    When the admin removes the first volunteer from the shift
    And a call arrives from a unique caller
    Then only the second volunteer should be rung
