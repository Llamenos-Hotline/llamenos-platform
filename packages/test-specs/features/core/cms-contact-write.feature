@backend
Feature: CMS contact write operations
  Admins and volunteers create and update encrypted contact profiles
  with blind indexes. (Entity field files: hub-files.feature.)

  @contact-write
  Scenario: Create a contact with E2EE profile
    Given case management is enabled
    When the admin creates a contact with encrypted profile
    Then the contact should have a generated UUID id
    And the contact should have an encrypted summary

  @contact-write
  Scenario: Update a contact's encrypted profile
    Given case management is enabled
    And a contact exists with identifier hash "testhash_write_update"
    When the admin updates the contact's encrypted profile
    Then the contact should have updated encrypted profile
