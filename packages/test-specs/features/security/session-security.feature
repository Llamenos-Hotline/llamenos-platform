# @wip: needs DB clock control a shared BDD server cannot give — #1194
@backend @security @wip
Feature: Session security hardening
  Sessions are cleaned up on device revocation, have an absolute maximum
  lifetime, and WebAuthn challenges are consumed atomically.

  # --- C02: Session Cleanup on Device Revocation ---

  @backend
  Scenario: Revoked device sessions are immediately invalidated
    Given a registered user with an active device "device-1"
    And the user has an active session linked to "device-1"
    When the user revokes device "device-1"
    Then all sessions for "device-1" should be deleted
    And the session token should return 401 when used

  @backend
  Scenario: Revoking a device does not affect other device sessions
    Given a registered user with devices "device-1" and "device-2"
    And the user has active sessions for both devices
    When the user revokes device "device-1"
    Then sessions for "device-2" should remain valid
    And the "device-2" session token should still authenticate

  @backend
  Scenario: Session deletion is atomic with device deletion
    Given a registered user with an active device "device-1"
    And the user has an active session linked to "device-1"
    When the user revokes device "device-1"
    Then the device record should not exist in the database
    And no sessions for "device-1" should exist in the database

  # --- H06: Session Absolute Max Lifetime ---

  @backend
  Scenario: Session within max lifetime is renewed normally
    Given a session created 6 days ago with 30 minutes remaining
    When the session is validated
    Then the session should be renewed with a new expiry

  @backend
  Scenario: Session exceeding max lifetime is rejected
    Given a session created 8 days ago
    When the session is validated
    Then the response status should be 401
    And the session should be deleted from the database

  @backend
  Scenario: Session at exactly 7 days is rejected
    Given a session created exactly 7 days ago
    When the session is validated
    Then the response status should be 401

  # --- H08: WebAuthn Challenge Atomic Consume ---

  @backend
  Scenario: Valid challenge is consumed and returned
    Given a WebAuthn challenge created 2 minutes ago
    When the challenge is consumed
    Then the challenge value should be returned
    And the challenge should not exist in the database

  @backend
  Scenario: Expired challenge returns 410
    Given a WebAuthn challenge created 6 minutes ago
    When the challenge is consumed
    Then the response status should be 410

  @backend
  Scenario: Missing challenge returns 404
    When a non-existent challenge is consumed
    Then the response status should be 404

  @backend
  Scenario: Concurrent challenge consume attempts — only one succeeds
    Given a valid WebAuthn challenge
    When two simultaneous consume requests arrive
    Then exactly one should succeed with the challenge value
    And the other should receive 404
