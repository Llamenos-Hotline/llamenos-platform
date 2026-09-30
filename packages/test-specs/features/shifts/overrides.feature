# @wip: Background steps and REST vocabulary have no backend definitions — #1122
@backend @desktop @ios @wip
Feature: Shift Overrides
  As an admin
  I want to create shift overrides
  So that I can cancel or substitute shifts for specific dates

  Background:
    Given I am authenticated as an admin
    And I have an active hub

  Scenario: Create a cancel override
    When I POST to "/hubs/{hubId}/shifts/overrides" with:
      | id   | a valid UUID |
      | date | "2026-06-15"  |
      | type | "cancel"      |
    Then the response status should be 200
    And the response body "type" should equal "cancel"
    And the response body "date" should equal "2026-06-15"

  Scenario: Create a substitute override
    When I POST to "/hubs/{hubId}/shifts/overrides" with:
      | id          | a valid UUID      |
      | date        | "2026-06-20"       |
      | type        | "substitute"       |
      | userPubkeys | ["vol-pubkey-1"]  |
    Then the response status should be 200
    And the response body "type" should equal "substitute"

  Scenario: List overrides by date range
    Given overrides exist for 2026-06-01 to 2026-06-30
    When I GET "/hubs/{hubId}/shifts/overrides?from=2026-06-01&to=2026-06-30"
    Then the response status should be 200
    And the response body "overrides" should be an array

  Scenario: Delete an override
    Given an override exists on date "2026-07-04"
    When I DELETE "/hubs/{hubId}/shifts/overrides/{overrideId}"
    Then the response status should be 200
    And the response body "ok" should be true

  Scenario: Reject invalid override type
    When I POST to "/hubs/{hubId}/shifts/overrides" with:
      | id   | a valid UUID |
      | date | "2026-06-15"  |
      | type | "invalid"     |
    Then the response status should be 400

  Scenario: Non-admin cannot create overrides
    Given I am authenticated as a volunteer
    When I POST to "/hubs/{hubId}/shifts/overrides" with any valid data
    Then the response status should be 403
