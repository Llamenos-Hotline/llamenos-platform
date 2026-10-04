@backend @integration @signal
Feature: Signal Adapter Integration
  As the Signal messaging adapter
  I want to handle inbound and outbound messages end-to-end
  So that Signal is a fully functional messaging channel

  # ── Inbound Message Flow ─────────────────────────────────────────

  Scenario: Inbound Signal message creates conversation
    Given the Signal webhook is configured
    When an inbound Signal message arrives from "+15551112222" with body "I need help"
    Then a conversation should be created with channel type "signal"
    And the conversation should contain the original message body

  Scenario: Outbound Signal reply is delivered
    Given an active Signal conversation from "+15551112222"
    When a volunteer sends the reply "We can help you"
    Then the outbound message should be dispatched to the Signal bridge
    And the message status should be "sent"

  Scenario: Signal delivery receipt updates message status
    Given an outbound Signal message was sent with timestamp "1700000000000"
    When a delivery receipt webhook arrives for timestamp "1700000000000"
    Then the message status should be updated to "delivered"

  Scenario: Signal reaction creates reaction event
    Given an active Signal conversation
    When a reaction webhook arrives with emoji "heart" targeting timestamp "1700000000001"
    Then a MESSAGE_REACTION WebSocket event should be published
    And the event should contain the emoji "heart"

  Scenario: Signal typing indicator publishes WebSocket event
    Given an active Signal conversation
    When a typing STARTED webhook arrives from the Signal contact
    Then a TYPING_INDICATOR WebSocket event should be published
    And the event should indicate typing is active

  # ── Registration & Verification ──────────────────────────────────

  Scenario: Signal number registration and verification
    Given the admin is authenticated
    When the admin registers Signal number "+15559990000"
    Then the registration state should be "pending_verification"
    When the admin submits the verification code "654321"
    Then the registration state should be "verified"
    And an audit log entry should be created for the registration

  # ── Edge Cases ────────────────────────────────────────────────────

  Scenario: Second inbound message from same number reuses conversation
    Given an existing Signal conversation from "+15551112222"
    When another inbound Signal message arrives from the same number
    Then the message should be appended to the existing conversation

  @fixme
  # Tracked in #1196.
  # Requires a configured Signal adapter (signal-cli registered number).
  # In CI the Signal bridge runs without a registered number, so the adapter
  # returns 404. Re-enable once the test environment configures Signal credentials.
  Scenario: Unrecognised envelope type is acknowledged without error
    Given the Signal webhook is configured
    When an unknown envelope type arrives via the Signal webhook
    Then the webhook should return 200 OK
    And no conversation should be created
