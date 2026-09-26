@backend @security @crypto
Feature: Hub Key Lifecycle
  As the encryption system
  I want hub keys to be securely distributed and rotated
  So that only current members can decrypt hub-encrypted data

  # ── Key Distribution ─────────────────────────────────────────────

  Scenario: Hub key distributed to all members
    Given a hub with 3 members: "Alice", "Bob", and "Carol"
    When the admin sets hub key envelopes for all 3 members
    Then "Alice" should be able to fetch their hub key envelope
    And "Bob" should be able to fetch their hub key envelope
    And "Carol" should be able to fetch their hub key envelope
    And each envelope should be unique per member

  # ── Revocation on Removal ────────────────────────────────────────

  Scenario: Removed member loses hub key access
    Given a hub with 3 members: "Alice", "Bob", and "Carol"
    And hub key envelopes are set for all 3 members
    When "Carol" is removed from the hub
    And the admin updates hub key envelopes for "Alice" and "Bob" only
    Then "Alice" should be able to fetch their hub key envelope
    And "Bob" should be able to fetch their hub key envelope
    And "Carol" should receive 404 when fetching their hub key envelope

  # ── Key Rotation ─────────────────────────────────────────────────

  Scenario: Hub key rotation on member departure
    Given a hub with 3 members: "Alice", "Bob", and "Carol"
    And hub key envelopes are set for all 3 members
    When "Carol" is removed from the hub
    And a new hub key is generated and wrapped for remaining members only
    Then "Alice"'s new envelope should differ from the original
    And "Bob"'s new envelope should differ from the original
    And the new envelopes should contain exactly 2 entries

  Scenario: A stale distribute cannot undo a rotation
    Given a hub with 3 members: "Alice", "Bob", and "Carol"
    And hub key envelopes are set for all 3 members
    When "Carol" is removed from the hub
    And a new hub key is generated and wrapped for remaining members only
    And a stale distribute re-sends the previous generation's envelopes for all 3 members
    Then the hub key write should be rejected with 409
    And "Carol" should receive 404 when fetching their hub key envelope
    And "Alice" should be able to fetch their hub key envelope

  # ── Auth Guards ───────────────────────────────────────────────────

  Scenario: Unauthenticated request to hub key endpoint returns 401
    Given a hub exists with a member "Alice"
    And hub key envelopes are set for "Alice"
    When an unauthenticated client requests the hub key
    Then the hub key response status should be 401

  Scenario: Non-member cannot fetch hub key envelope
    Given a hub exists with a member "Alice"
    And hub key envelopes are set for "Alice"
    And a volunteer "Eve" who is not a hub member
    When "Eve" requests the hub key envelope
    Then the hub key response status should be 403

  Scenario: Member without an envelope receives 404
    Given a hub exists with a member "Alice"
    And hub key envelopes are set for "Alice"
    And a volunteer "Bob" is added to the hub but has no envelope
    When "Bob" requests the hub key envelope
    Then the hub key response status should be 404
