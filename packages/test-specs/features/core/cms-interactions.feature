@backend
Feature: CMS Interactions
  Case timelines track inline comments, status changes,
  and linked entities as chronological interactions.

  @cases
  Scenario: Create inline comment on case timeline
    Given case management is enabled
    And an entity type "comment_case_type" exists
    And a record of type "comment_case_type" exists
    When the admin creates a comment interaction on the record
    Then the interaction should have type "comment"
    And the interaction should have encrypted content

  @cases
  Scenario: Auto-create status_change interaction on status update
    Given case management is enabled
    And an entity type "sc_case_type" exists
    And a record of type "sc_case_type" exists with status "initial"
    When the admin updates the record status with change metadata
    Then the record interactions should include a "status_change" entry

  @cases
  Scenario: List interactions chronologically
    Given case management is enabled
    And an entity type "timeline_case_type" exists
    And a record of type "timeline_case_type" exists
    And 3 comment interactions exist on the record
    When the admin lists interactions for the record
    Then 3 interactions should be returned
    And the interactions should be in chronological order
