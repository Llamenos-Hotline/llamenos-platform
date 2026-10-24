@desktop
Feature: Inbound messages reach the conversation list
  As an admin
  I want every message that arrives at my hub to open or extend a conversation
  So that no text contact goes unanswered

  # Messages are simulated into the worker's own hub, the way a provider webhook
  # carrying ?hub= files them. The conversation list is hub-scoped, so this is the
  # path a real deployment takes — never a conversation that belongs to no hub.

  Background:
    Given I am logged in as an admin

  Scenario: An inbound SMS opens a conversation
    When an inbound "sms" message arrives at my hub from a new number
    Then that sender's conversation should appear in the conversation list

  Scenario: An inbound WhatsApp message opens a conversation
    When an inbound "whatsapp" message arrives at my hub from a new number
    Then that sender's conversation should appear in the conversation list

  Scenario: Repeated messages from one sender share one conversation
    When 2 inbound "sms" messages arrive at my hub from the same new number
    Then those messages should belong to one conversation
    And opening that sender's conversation should show every message in its thread
