@backend @desktop @ios @android @security
Feature: E2EE Roundtrip
  As the encryption system
  I want end-to-end encryption to work across all platforms
  So that data is never readable by the server

  @backend
  Scenario: Note encrypt-store-decrypt roundtrip
    Given a volunteer with a known keypair
    And an admin with a known keypair
    When the volunteer encrypts a note "Confidential information"
    And the encrypted envelope is stored on the server
    And the volunteer retrieves and decrypts the note
    Then the decrypted text should be "Confidential information"

  @backend
  Scenario: Admin can decrypt volunteer's note via admin envelope
    Given a volunteer with a known keypair
    And an admin with a known keypair
    When the volunteer encrypts a note "Admin should read this"
    And the encrypted envelope is stored on the server
    And the admin retrieves and decrypts the note with their key
    Then the decrypted text should be "Admin should read this"

  @backend
  Scenario: Third party cannot decrypt note without key
    Given a volunteer with a known keypair
    And a third party with a different keypair
    When the volunteer encrypts a note "Secret data"
    And the third party attempts to decrypt the note
    Then decryption should fail

  @backend
  Scenario: Message encrypt-store-decrypt roundtrip
    Given a volunteer with a known keypair
    And the volunteer has registered a device encryption key
    And an admin with a known keypair
    And the admin has registered a device encryption key
    When a message "Help me" is encrypted for volunteer and admin
    And the encrypted message is stored on the server
    Then the volunteer can decrypt the message to "Help me"
    And the admin can decrypt the message to "Help me"
    And no reader envelope is addressed to an auth key

  @backend
  Scenario: The server never seals a message to an auth key
    Given a volunteer with a known keypair
    And an admin with a known keypair
    And the admin has registered a device encryption key
    When a message "No device key yet" is encrypted for volunteer and admin
    And the encrypted message is stored on the server
    Then no reader envelope is addressed to an auth key
    And the admin can decrypt the message to "No device key yet"

  @backend
  Scenario: Multi-admin envelope verification
    Given a hub with 3 admins with known keypairs
    When a volunteer encrypts a note "Multi-admin test"
    Then all 3 admins can decrypt the note independently
    And each admin's key wrap is unique
