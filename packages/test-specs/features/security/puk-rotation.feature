@backend @security @crypto
Feature: PUK Rotation
  As the key management system
  I want per-user key envelopes distributed to each device the user's sigchain authorises
  So that key rotation re-wraps secrets without trusting the server

  Background:
    Given a registered user with a known keypair

  @backend
  Scenario: Distribute PUK envelopes to a single device
    Given the user's sigchain authorises device "device-alpha"
    When the user distributes PUK envelopes for generation 1
    Then the response status is 201
    And 1 PUK envelope is stored

  @backend
  Scenario: Retrieve the latest PUK envelope for a device
    Given the user's sigchain authorises device "device-alpha"
    And PUK envelopes are distributed for generation 1
    When the user fetches the PUK envelope for "device-alpha"
    Then the response status is 200
    And the PUK envelope generation is 1
    And the fetched envelope opens on "device-alpha" to the latest PUK seed

  @backend
  Scenario: Higher generation supersedes previous
    Given the user's sigchain authorises device "device-alpha"
    And PUK envelopes are distributed for generation 1
    And PUK envelopes are distributed for generation 2
    When the user fetches the PUK envelope for "device-alpha"
    Then the PUK envelope generation is 2
    And the fetched envelope opens on "device-alpha" to the latest PUK seed

  @backend
  Scenario: Distribute envelopes for multiple devices
    Given the user's sigchain authorises device "device-alpha"
    And the user's sigchain authorises device "device-beta"
    When the user distributes PUK envelopes for generation 1 to all devices
    Then the response status is 201
    And 2 PUK envelopes are stored

  @backend
  Scenario: Reject an envelope addressed to a device the sigchain does not authorise
    Given the user's sigchain authorises device "device-alpha"
    When the user distributes a PUK envelope to unauthorised device "device-rogue"
    Then the response status is 400
    And the error message contains "does not authorise"

  @backend
  Scenario: Reject a PUK envelope that is not an HPKE envelope
    Given the user's sigchain authorises device "device-alpha"
    When the user distributes a PUK envelope that is not an HPKE envelope
    Then the response status is 400

  @backend
  Scenario: No envelope found for unknown device
    When the user fetches the PUK envelope for "nonexistent-device"
    Then the response status is 404
