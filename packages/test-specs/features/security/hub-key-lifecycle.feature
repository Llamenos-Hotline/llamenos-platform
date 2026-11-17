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

  # PROTOCOL.md §2.7 "Key Rotation": a real departure (DELETE /hubs/:id/members)
  # marks the key due; the rotation endpoint refuses a new key for the leaver
  # and refuses one that leaves a member out; a complete rotation installs the
  # new wraps, moves the epoch and clears the flag.

  Scenario: Hub key rotation on member departure
    Given a hub with 3 members: "Alice", "Bob", and "Carol"
    And hub key envelopes are set for all 3 members
    When "Carol" leaves the hub
    Then the hub key should be due a rotation
    And a rotation that also wraps the new key for "Carol" should be refused with 403
    And a rotation that leaves "Bob" out should be refused with 409
    When the admin rotates the hub key for the remaining members
    Then the hub key should not be due a rotation
    And the hub key epoch should be 1
    And "Alice" should be able to fetch their hub key envelope
    And "Bob" should be able to fetch their hub key envelope
    And "Carol" should receive 403 when fetching their hub key envelope
    And every hub key wrap should be of the rotated key

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

  # ── Distribution contract (#1042) ────────────────────────────────
  # The client lifecycle (src/client/lib/hub-key-manager.ts) relies on these:
  # a key write names the generation it read, so two managers cannot each
  # install a key; and a distributor learns every member's DEVICE key and the
  # wraps that already exist, so it adds without replacing anyone's access.

  Scenario: A hub key write that names a stale generation is refused and changes nothing
    Given a hub with 3 members: "Alice", "Bob", and "Carol"
    When the admin sets hub key envelopes for all 3 members
    Then the hub key generation should be 1
    And a hub key write at generation 0 should be refused with 409
    And "Alice" should be able to fetch their hub key envelope

  Scenario: A key distributor sees every member's device key and the wraps already held
    Given a hub with 3 members: "Alice", "Bob", and "Carol"
    When the admin updates hub key envelopes for "Alice" and "Bob" only
    Then the key recipients should list every member with their device key
    And the key recipients should hold a wrap for exactly "Alice" and "Bob"

  Scenario: An instance admin with no role in the hub cannot install or read its key distribution
    Given a hub with 3 members: "Alice", "Bob", and "Carol"
    When "Alice" becomes the hub's admin and the instance admin leaves it
    Then the instance admin cannot read or write the hub's key distribution
    And "Alice" can read the hub's key distribution
