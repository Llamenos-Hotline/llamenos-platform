@desktop
Feature: Encrypted Backup Restore
  As a user who has lost access to a device
  I want to restore my device key from the encrypted backup I downloaded
  So that I can sign in again without my old device

  # The backup format itself (container v4, both KDFs, the cipher) is proven by
  # the round-trip tests over the real Rust codec in packages/crypto/src/backup.rs.
  # These scenarios prove the UI around it: that a backup written by the app can
  # be read back by the app, that a wrong credential is reported where it was
  # entered, and that an unreadable file is rejected before a credential is
  # asked for (#1709).

  Scenario: Restoring with the recovery key reaches the new-PIN step
    Given I have downloaded an encrypted backup of my device key
    And I am on the login screen
    When I upload my encrypted backup file
    And I enter my recovery key
    And I submit the backup for decryption
    Then I should be asked to create a new PIN

  Scenario: Completing the new PIN loads the restored device key
    Given I have downloaded an encrypted backup of my device key
    And I am on the login screen
    When I upload my encrypted backup file
    And I enter my recovery key
    And I submit the backup for decryption
    And I set a new PIN of "restore-pin-9"
    Then the restored device key matches the one the backup was made from

  Scenario: Restoring with the backup PIN reaches the new-PIN step
    Given I have downloaded an encrypted backup of my device key
    And I am on the login screen
    When I upload my encrypted backup file
    And I enter the PIN the backup was made with
    And I submit the backup for decryption
    Then I should be asked to create a new PIN

  Scenario: A different recovery key is rejected
    Given I have downloaded an encrypted backup of my device key
    And I am on the login screen
    When I upload my encrypted backup file
    And I enter a different recovery key
    And I submit the backup for decryption
    Then I should see "Failed to decrypt backup"

  Scenario: A backup file from an older build is rejected as unreadable
    Given I am on the login screen
    When I upload a version 3 backup file
    Then I should see "Invalid backup file"
