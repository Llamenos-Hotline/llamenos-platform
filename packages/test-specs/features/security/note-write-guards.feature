@backend @security @crypto
Feature: Note and message write guards
  As the server that can never read an E2EE record
  I want to refuse a write that would orphan it or file it under the wrong call
  So that "admins can always read" and hub isolation hold no matter what the client sends

  # The server cannot re-wrap a client-sealed content key, so an envelope set that
  # names no admin is unrecoverable the moment it is stored (#2113). A callId or
  # conversationId that is not a real record of this hub lets a note be filed
  # under an invented call, or under another hub's call (#2112).

  Background:
    Given hub "Alpha" and hub "Beta" exist for note guards
    And a volunteer "Vera" who is a member of hub "Alpha" for note guards
    And a call rings in hub "Alpha" for note guards
    And a call rings in hub "Beta" for note guards

  Scenario: A note with no admin envelope is refused and nothing is stored
    When "Vera" posts a note to hub "Alpha" on the "Alpha" call with no admin envelopes
    Then the note write is refused with status 422
    And hub "Alpha" holds no note for the "Alpha" call

  Scenario: A note whose envelopes name no admin key is refused
    When "Vera" posts a note to hub "Alpha" on the "Alpha" call sealed only to herself
    Then the note write is refused with status 422
    And hub "Alpha" holds no note for the "Alpha" call

  Scenario: A note on a call that does not exist is refused
    When "Vera" posts a well-formed note to hub "Alpha" on call "does-not-exist-123"
    Then the note write is refused with status 404
    And hub "Alpha" holds no note for call "does-not-exist-123"

  Scenario: A note on another hub's call is refused
    When "Vera" posts a well-formed note to hub "Alpha" on the "Beta" call
    Then the note write is refused with status 404
    And hub "Alpha" holds no note for the "Beta" call

  Scenario: A note on a conversation that does not exist is refused
    When "Vera" posts a well-formed note to hub "Alpha" on conversation "does-not-exist-123"
    Then the note write is refused with status 404

  Scenario: A well-formed note is stored and both the volunteer and the admin can open it
    When "Vera" posts a well-formed note to hub "Alpha" on the "Alpha" call
    Then the note write succeeds
    And the note row is stored in hub "Alpha" against the "Alpha" call
    And "Vera" can decrypt the stored note to the text she wrote
    And the admin can decrypt the stored note to the text she wrote

  Scenario: Editing a note so that it drops the admin envelope is refused
    Given "Vera" has posted a well-formed note to hub "Alpha" on the "Alpha" call
    When "Vera" edits that note with new content and no admin envelopes
    Then the note write is refused with status 422
    And the stored note can still be decrypted by the admin to its original text

  Scenario: A client-sealed message that names no admin key is refused
    Given an SMS conversation in hub "Alpha" for note guards
    When the admin sends a message into that conversation sealed only to a non-admin key
    Then the note write is refused with status 422

  Scenario: A client-sealed message that includes the admin key is stored
    Given an SMS conversation in hub "Alpha" for note guards
    When the admin sends a message into that conversation sealed to the admin key
    Then the note write succeeds
