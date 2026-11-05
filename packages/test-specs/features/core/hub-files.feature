@backend @hub-files
Feature: Files belong to a hub
  Every file is uploaded into a hub and names a parent inside it (#2462). Uploads
  are authorised by the caller's role IN that hub, so an ordinary hub member can
  attach a file, the hub's admins can read it, and nothing outside the hub can
  reach it.

  Scenario: A member whose only grant is a hub role uploads an entity field file
    Given a volunteer who joined the hub by invite
    When the volunteer uploads an entity field file to the hub
    Then the upload succeeds as a file of the hub
    And the volunteer can download the file and open it with their envelope

  Scenario: A hub admin reads a file a member uploaded
    Given a volunteer who joined the hub by invite
    And a hub admin who joined the hub by invite
    When the volunteer uploads an entity field file to the hub
    Then the hub admin can read every envelope of the file

  Scenario: A file is not reachable through another hub
    Given a volunteer who joined the hub by invite
    And another hub exists
    When the volunteer uploads an entity field file to the hub
    Then requesting the file through the other hub answers 404

  Scenario: An upload cannot name a case record of another hub
    Given case management is enabled
    And an entity type "hub_files_case_type" exists
    And a record of type "hub_files_case_type" exists
    And another hub exists
    When the admin starts an upload in the other hub naming that record
    Then the upload is refused with 404

  Scenario: Uploads are not served outside a hub
    When the admin starts an upload on the unscoped route
    Then the upload is refused with 404

  Scenario: Evidence must name a file uploaded to its record
    Given case management is enabled
    And an entity type "hub_files_case_type" exists
    And a record of type "hub_files_case_type" exists
    When the admin registers evidence naming a file that was never uploaded
    Then the evidence registration is refused with 404
