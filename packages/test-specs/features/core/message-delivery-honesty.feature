@backend
Feature: Message Delivery Honesty
  As the messaging system
  I want a stored reply's status to tell the truth about delivery
  So that a volunteer never believes they answered someone the provider never reached

  # `sent` means a provider accepted the message (#2551). A reply the
  # configured bridge never received is stored as failed with the reason, so
  # the volunteer sees the failure and can retry — never a sent-looking record
  # for a message the caller did not get.
  #
  # Writes the instance-wide messaging config, so it runs in the serial
  # @global-setting project; the step file's After hook resets it
  # (tests/steps/backend/message-delivery-integrity.steps.ts).
  @global-setting
  Scenario: A reply no provider accepted is stored as failed, never as sent
    Given the "signal" channel is configured with an unreachable bridge
    And an active Signal conversation from "+15557779999"
    When a volunteer sends the reply "We can help you"
    Then the message status should be "failed"
    And the last outbound message should record a failure reason
