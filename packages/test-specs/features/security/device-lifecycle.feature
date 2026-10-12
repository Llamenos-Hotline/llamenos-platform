# The device-linking wire protocol (QR format, room transport, roles, SAS
# ceremony, key-bundle payload, failure modes) is specified in
# docs/protocol/PROTOCOL.md §6 (Device Linking Protocol, issue #1027).
# These scenarios are the lifecycle contract (register/list/revoke) that
# linked devices operate under once imported.
@backend @security @crypto
Feature: Device Lifecycle
  As a multi-device user
  I want to register, list, and revoke devices
  So that compromised devices can be removed and keys rotated

  Background:
    Given a registered user with a known keypair

  @backend
  Scenario: Register a new device
    When the user registers a device with platform "ios"
    Then the response status is 204

  @backend
  Scenario: List authorized devices
    Given the user registers a device with platform "ios"
    And the user registers a device with platform "android"
    When the user lists their devices
    Then the response status is 200
    And 2 devices are listed
    And one device has platform "ios"
    And one device has platform "android"

  @backend
  Scenario: Deregister a specific device
    Given the user registers a device with platform "ios"
    When the user lists their devices
    And the user deregisters the first device
    Then the response status is 204
    And the user has 0 devices

  @backend
  Scenario: Deregistering a nonexistent device returns 404
    When the user deregisters device "nonexistent-id"
    Then the response status is 404

  @backend
  Scenario: Delete all devices on logout
    Given the user registers a device with platform "ios"
    And the user registers a device with platform "android"
    When the user deletes all their devices
    Then the response status is 204
    And the user has 0 devices

  @backend
  Scenario: Register device with Phase 6 crypto keys
    When the user registers a device with Ed25519 and X25519 keys
    Then the response status is 204
    And the device lists show the Ed25519 public key

  @backend
  Scenario: Register VoIP push token
    Given the user registers a device with platform "ios"
    When the user registers a VoIP token
    Then the response status is 204

  @backend
  Scenario: Rename a device
    Given the user registers a device with platform "ios"
    And the user lists their devices
    When the user renames the first device to "My Laptop"
    Then the response status is 200
    And the device name is "My Laptop"

  @backend
  Scenario: Rename a nonexistent device returns 404
    When the user renames device "nonexistent-id" to "Ghost"
    Then the response status is 404

  @backend
  Scenario: Revoke a device
    Given the user registers a device with platform "ios"
    And the user lists their devices
    When the user revokes the first device
    Then the response status is 200
    And the user has 0 devices

  @backend
  Scenario: Revoke without confirm returns 400
    Given the user registers a device with platform "ios"
    And the user lists their devices
    When the user revokes the first device without confirmation
    Then the response status is 400
