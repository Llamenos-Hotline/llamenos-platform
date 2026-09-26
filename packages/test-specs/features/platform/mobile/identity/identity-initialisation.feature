@android
Feature: User identity initialisation on mobile
  A user created on a phone gets the identity state every client produces
  (docs/protocol/PROTOCOL.md §2.11 "Identity initialisation"): a seq 1 genesis
  link naming this device, a first PUK sealed to this device, and a seq 2
  puk_epoch link binding the PUK's public keys — and the stored chain verifies
  with packages/crypto verify_sigchain.

  Mobile keys exist before the server knows the user (an admin registers the
  pubkey), so initialisation waits until the user is registered and is retried
  on every unlock.

  Scenario: A user created on this device gets a verifying genesis link and PUK
    Given I have created a new identity on this device
    Then identity initialisation waits until the server knows this user
    When the hub registers this device's user
    And the app initialises this user's identity
    Then this user's sigchain is a genesis link followed by a PUK epoch
    And the stored sigchain verifies and authorises only this device
    And the genesis link names this device's keys
    And this device opens its PUK envelope to the keys the chain names

  Scenario: Initialising an existing identity adds no links
    Given I have created a new identity on this device
    And the hub registers this device's user
    And the app initialises this user's identity
    When the app initialises this user's identity
    Then this user's sigchain is a genesis link followed by a PUK epoch
    And the stored sigchain verifies and authorises only this device
