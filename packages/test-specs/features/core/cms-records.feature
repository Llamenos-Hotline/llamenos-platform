@backend
Feature: CMS Records
  Admins and volunteers create and manage encrypted case records
  with blind-index filtering, contact linking, and assignment.

  @cases
  Scenario: Create record with encrypted content and blind indexes
    Given case management is enabled
    And an entity type "record_test_type" exists
    When the admin creates a record of type "record_test_type" with status "open"
    Then the record should have a generated UUID id
    And the record should have entity type "record_test_type"
    And the record's sealed summary should carry status "open"
    And the record should expose no status, severity or category to the server

  @cases
  Scenario: List records filtered by entity type
    Given case management is enabled
    And an entity type "filter_type_a" exists
    And an entity type "filter_type_b" exists
    And a record of type "filter_type_a" exists
    And a record of type "filter_type_b" exists
    When the admin lists records filtered by entity type "filter_type_a"
    Then all returned records should have entity type "filter_type_a"

  @cases
  Scenario: Link contact to record with role
    Given case management is enabled
    And an entity type "link_test_type" exists
    And a record of type "link_test_type" exists
    And a contact exists
    When the admin links the contact to the record with role "arrestee"
    Then the record should have 1 linked contact
    And the linked contact should have role "arrestee"

  @cases
  Scenario: Assign volunteer to record
    Given case management is enabled
    And an entity type "assign_test_type" exists
    And a record of type "assign_test_type" exists
    And a volunteer exists for assignment
    When the admin assigns the volunteer to the record
    Then the record should include the volunteer in assignedTo

  @cases
  Scenario: Generate case number with auto-increment
    Given case management is enabled
    And an entity type with number prefix "RC" exists
    When the admin creates a record of the numbered type
    Then the record should have a case number matching "RC-{year}-0001"
    When the admin creates another record of the numbered type
    Then the second record should have a case number matching "RC-{year}-0002"

  @cases
  Scenario: Update record status
    Given case management is enabled
    And an entity type "status_test_type" exists
    And a record of type "status_test_type" exists with status "open"
    When the admin changes the record status to "closed"
    Then the record's sealed summary should carry status "closed"
    And the record should expose no status, severity or category to the server

  @cases
  Scenario Outline: A record write that names a plaintext triage field is refused
    Given case management is enabled
    And an entity type "refused_plaintext_type" exists
    When the admin tries to create a record that names "<field>" in plaintext
    Then the response status should be 400

    Examples:
      | field        |
      | statusHash   |
      | severityHash |
      | categoryHash |

  @cases @permissions
  Scenario: Volunteer sees only assigned records
    Given case management is enabled
    And an entity type "scoped_type" exists
    And a record of type "scoped_type" exists
    And a volunteer exists with cases:read-own and cases:create permissions
    When the volunteer lists records
    Then the volunteer should see 0 records
    When the admin assigns the volunteer to the record
    And the volunteer lists records
    Then the volunteer should see 1 records
