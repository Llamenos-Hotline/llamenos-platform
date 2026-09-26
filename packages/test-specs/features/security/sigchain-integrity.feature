@backend @security @crypto
Feature: Sigchain Integrity
  As the key management system
  I want to maintain tamper-evident, hash-chained device authorization records
  So that device compromise cannot silently rewrite history

  Background:
    Given a registered user with a known keypair

  @backend
  Scenario: Append a valid genesis link to an empty sigchain
    When the user appends a genesis sigchain link
    Then the response status is 201
    And the sigchain has 1 link
    And the first link has linkType "genesis"

  @backend
  Scenario: Append a device_add link after genesis
    Given the user has a genesis sigchain link
    When the user appends a "device_add" link with valid prevHash
    Then the response status is 201
    And the sigchain has 2 links

  @backend
  Scenario: Reject link with invalid signature
    Given the user has a genesis sigchain link
    When the user appends a link with an invalid Ed25519 signature
    Then the response status is 400

  @backend
  Scenario: Reject link that breaks hash chain
    Given the user has a genesis sigchain link
    When the user appends a link with wrong prevHash
    Then the response status is 409

  @backend
  Scenario: Reject duplicate seqNo
    Given the user has a genesis sigchain link
    When the user appends a link with duplicate seqNo 1
    Then the response status is 409

  @backend
  Scenario: Reject a first link that is not a genesis link
    When the user appends a device_add link as the first link of their sigchain
    Then the response status is 400
    And the error message contains "must be a genesis link"

  @backend
  Scenario: Reject a link signed by a key other than the user's identity key
    When the user appends a genesis link signed by a key other than their identity key
    Then the response status is 400
    And the error message contains "identity key"

  @backend
  Scenario: Only the owner can append to their sigchain
    Given a second registered user
    When the second user tries to append to the first user's sigchain
    Then the response status is 403

  @backend
  Scenario: Admin can read another user's sigchain
    Given the user has a genesis sigchain link
    When the admin reads the user's sigchain
    Then the response status is 200
    And the sigchain has 1 link

  @backend
  Scenario: Volunteer cannot read another user's sigchain
    Given a second registered user
    When the second user tries to read the first user's sigchain
    Then the response status is 403

  @backend
  Scenario: Accept link with valid recomputed hash
    When the user appends a genesis sigchain link with correctly computed hash
    Then the response status is 201
    And the sigchain has 1 link

  @backend
  Scenario: Reject link with tampered payload (hash mismatch)
    When the user appends a sigchain link whose payload was modified after hashing
    Then the response status is 400
    And the error message contains "hash mismatch"

  @backend
  Scenario: Reject link with forged hash that does not bind to content
    When the user appends a sigchain link with a hash that does not match the canonical content
    Then the response status is 400
    And the error message contains "hash mismatch"

  # ── Identity initialisation (#1050, PROTOCOL.md §2.11) ──────────────────

  @backend
  Scenario: A user created from nothing gets a verifying genesis link and PUK
    When the user initialises their identity
    Then the sigchain link types are "1:genesis,2:puk_epoch"
    And the stored sigchain verifies and authorises only the user's device
    And the user's device opens its PUK envelope to the seed the puk_epoch link binds
