@backend
Feature: Cross-DO Integration Workflows
  Verify end-to-end workflows that span multiple Durable Objects,
  ensuring consistent state across IdentityDO, ShiftManagerDO,
  CallRouterDO, RecordsDO, and ConversationDO.

  # ─── Volunteer Onboarding → Call → Note ────────────────────────────

  Scenario: Complete volunteer onboarding through call completion
    When an admin creates a volunteer
    And the admin creates a shift including the volunteer
    And an incoming call arrives
    And the volunteer answers the call
    And the volunteer writes a note for the call
    Then the call history should show a completed call
    And the notes list should contain the volunteer's note
    And the audit log should have entries for each step

  # ─── Ban Lifecycle with Call Integration ───────────────────────────

  Scenario: Ban prevents call then unban allows call
    Given 1 volunteers are on shift
    When an admin bans "+15550000001"
    And an incoming call arrives from "+15550000001"
    Then the banned call should be rejected
    When the admin removes the ban for "+15550000001"
    And an incoming call arrives from "+15550000001"
    Then the call should be ringing

  # ─── Conversation Lifecycle ────────────────────────────────────────

  Scenario: Full conversation lifecycle with assignment
    Given 1 volunteers are on shift
    When an SMS arrives from "+15550002222" with body "Help me"
    Then a conversation should have been created
    When the volunteer claims the conversation
    Then the conversation status should be "active"
    When the admin closes the conversation
    Then the conversation status should be "closed"
    When another SMS arrives from "+15550002222" with body "Follow up"
    Then the conversation should be reopened

  # ─── Invite → Registration → Call Handling ─────────────────────────

  Scenario: Invited volunteer can handle calls
    When an admin creates an invite
    And the invite is redeemed by a new user
    And the admin creates a shift with the new volunteer
    And an incoming call arrives
    Then the new volunteer should be rung

  # ─── Multi-Channel Conversation Isolation ──────────────────────────

  Scenario: SMS and WhatsApp conversations are separate
    Given 1 volunteers are on shift
    When an SMS arrives from "+15550003333" with body "SMS help"
    And a WhatsApp message arrives from "+15550003333" with body "WA help"
    Then 2 separate conversations should exist
    And each conversation should have its own channel type

  # ─── Report with Assignment ────────────────────────────────────────

  Scenario: Report workflow across RecordsDO
    Given a reporter and reviewer exist
    When the reporter creates a report
    And the admin assigns the report to the reviewer
    Then the report should show the reviewer as assignee
    When the admin updates the report status to "closed"
    Then the report status should be "closed"
    And the audit log should contain report assignment entries

  # ─── Call with Voicemail Fallback ──────────────────────────────────

  Scenario: Unanswered call falls to voicemail
    Given 1 volunteers are on shift
    When an incoming call arrives
    And no volunteer answers within the timeout
    Then the call should go to voicemail
    And the call history should show an unanswered call

  # Removing a volunteer from the shift is asserted against the next call's real ring set
  # in signed-call-routing.feature (#1052).

  # ─── Conversation Notes Link ───────────────────────────────────────

  Scenario: Notes can be attached to conversations
    Given 1 volunteers are on shift
    When an SMS arrives from "+15550004444" with body "I need help"
    And the volunteer claims the conversation
    And the volunteer writes a note for the conversation
    Then the note should be linked to the conversation
    And listing notes by conversation returns the correct note
