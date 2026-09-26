@backend
Feature: Real-Time Relay Event Delivery
  The in-process WebSocket relay must deliver server-published events to
  authenticated subscribers. Every state mutation that publishes an event
  must result in the event arriving at the relay within 5 seconds.

  Background:
    And 1 volunteers are on shift
    And the test relay is connected and capturing events

  # --- Call Events ---

  @relay @calls
  Scenario: Incoming call publishes KIND_CALL_RING to relay
    When an incoming call arrives from a unique number
    Then the relay should receive a kind 1000 event within 5 seconds
    And the decrypted event content type should be "call:ring"
    And the event should contain a "callId" field

  @relay @calls
  Scenario: Answering a call publishes KIND_CALL_UPDATE to relay
    Given an incoming call is ringing
    When the first volunteer answers the call
    Then the relay should receive a kind 1001 event within 5 seconds
    And the decrypted event content type should be "call:update"
    And the event content "status" should be "in-progress"

  @relay @calls
  Scenario: Ending a call publishes KIND_CALL_UPDATE with completed status
    Given an incoming call is ringing
    And the first volunteer answers the call
    And the relay captured events are cleared
    When the active call is ended
    Then the relay should receive a kind 1001 event within 5 seconds
    And the decrypted event content type should be "call:update"
    And the event content "status" should be "completed"

  @relay @calls
  Scenario: Voicemail publishes KIND_CALL_VOICEMAIL to relay
    Given an incoming call is ringing
    When the call goes to voicemail
    Then the relay should receive a kind 1002 event within 5 seconds
    And the decrypted event content type should be "voicemail:new"

  # --- Presence Events ---

  @relay @presence
  Scenario: Answering a call publishes presence update to relay
    Given an incoming call is ringing
    When the first volunteer answers the call
    Then the relay should receive a kind 20000 event within 5 seconds
    And the decrypted event content type should be "presence:summary"

  # --- Messaging Events ---

  @relay @messaging
  Scenario: Inbound message publishes KIND_MESSAGE_NEW to relay
    When an inbound SMS message arrives from a unique number
    Then the relay should receive a kind 1010 event within 5 seconds
    And the decrypted event content type should be "message:new"
    And the event should contain a "conversationId" field

  # --- Event Encryption ---

  @relay @security
  Scenario: All relay events are encrypted with the server event key
    When an incoming call arrives from a unique number
    Then the relay should receive a kind 1000 event within 5 seconds
    And the raw event payload should NOT be valid JSON
    And the decrypted event content should be valid JSON

  # --- Event Structure ---

  @relay
  Scenario: All relay events carry protocol version and hubId
    When an incoming call arrives from a unique number
    Then the relay should receive a kind 1000 event within 5 seconds
    And the event version should be 1
    And the event hubId should be the scenario hub

  @relay @calls
  Scenario: A call ring is published to the hub the call arrived on
    When an incoming call arrives from a unique number
    Then the relay should receive a kind 1000 event within 5 seconds
    And the event hubId should be the scenario hub

  @relay @messaging
  Scenario: An inbound message is published to the hub it arrived on
    When an inbound SMS message arrives from a unique number
    Then the relay should receive a kind 1010 event within 5 seconds
    And the event hubId should be the scenario hub

  # --- Hub isolation ---

  @relay @security
  Scenario: A member of another hub cannot subscribe to this hub's events or to a global catch-all
    Given a volunteer who is a member of a different hub only
    Then that volunteer's relay subscription to the scenario hub should be refused
    And that volunteer's relay subscription to "global" should be refused
    And that volunteer's relay subscription to their own hub should be accepted

  @relay
  Scenario: All relay events are signed by the server
    When an incoming call arrives from a unique number
    Then the relay should receive a kind 1000 event within 5 seconds
    And the event signature should be valid
    And the event pubkey should match the server's configured pubkey
