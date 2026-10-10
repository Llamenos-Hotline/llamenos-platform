@backend @desktop @ios
Feature: Ring Group Management
  As an admin
  I want to manage ring groups
  So that I can assign named groups of volunteers to shifts

  Background:
    Given I am authenticated as an admin
    And I have an active hub

  Scenario: Create a ring group
    When I POST to "/hubs/{hubId}/ring-groups" with:
      | id            | a valid UUID          |
      | encryptedName | "encrypted-name-data" |
    Then the response status should be 200
    And the response body should contain "id"
    And the response body should contain "encryptedName"
    And the response body "members" array should be empty

  Scenario: List ring groups
    Given a ring group exists in the hub
    When I GET "/hubs/{hubId}/ring-groups"
    Then the response status should be 200
    And the response body "ringGroups" should be an array

  Scenario: Get ring group detail with members
    Given a ring group exists with 2 members
    When I GET "/hubs/{hubId}/ring-groups/{ringGroupId}"
    Then the response status should be 200
    And the response body "members" should have 2 entries

  Scenario: Update ring group name
    Given a ring group exists in the hub
    When I PUT to "/hubs/{hubId}/ring-groups/{ringGroupId}" with:
      | encryptedName | "new-encrypted-name" |
    Then the response status should be 200
    And the response body "encryptedName" should equal "new-encrypted-name"

  Scenario: Add members to ring group
    Given a ring group exists in the hub
    And a volunteer exists with pubkey "vol-pubkey-1"
    When I POST to "/hubs/{hubId}/ring-groups/{ringGroupId}/members" with:
      | pubkeys | ["vol-pubkey-1"] |
    Then the response status should be 200
    And the response body "members" should contain "vol-pubkey-1"

  Scenario: Remove members from ring group
    Given a ring group exists with member "vol-pubkey-1"
    When I DELETE "/hubs/{hubId}/ring-groups/{ringGroupId}/members" with:
      | pubkeys | ["vol-pubkey-1"] |
    Then the response status should be 200
    And the response body "members" should not contain "vol-pubkey-1"

  Scenario: Delete ring group
    Given a ring group exists in the hub
    When I DELETE "/hubs/{hubId}/ring-groups/{ringGroupId}"
    Then the response status should be 200
    And the response body "ok" should be true

  Scenario: Non-admin cannot manage ring groups
    Given I am authenticated as a volunteer
    When I GET "/hubs/{hubId}/ring-groups"
    Then the response status should be 403
