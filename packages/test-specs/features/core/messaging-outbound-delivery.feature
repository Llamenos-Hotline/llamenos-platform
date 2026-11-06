@backend @security
Feature: Outbound reply delivery
  A reply on an SMS, WhatsApp or Signal conversation carries two things: the sealed
  copy for the hub's readers, and the plaintext the carrier transmits. The server keeps
  no plaintext, so it cannot rebuild the second from the first (#2500).

  # Mobile sealed the reply and sent no plaintext, so the carrier received nothing while
  # the volunteer believed they had answered someone in crisis.
  Scenario: A reply carrying only the sealed copy is refused and nothing is stored
    Given a conversation exists for an SMS contact
    When a volunteer sends an outbound message sealed for the hub readers but carrying no plaintext
    Then the send is refused with status 422 and code "plaintext_for_sending_required"
    And no outbound message was stored for that conversation
