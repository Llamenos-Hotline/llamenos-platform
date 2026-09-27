# @wip: Background steps and REST vocabulary have no backend definitions — #1122
@backend @desktop @ios @wip
Feature: Availability Blocks
  As a volunteer
  I want to set availability blocks
  So that I am excluded from routing during periods I am unavailable

  Background:
    Given I am authenticated as a volunteer
    And I have an active hub

  Scenario: Create an availability block
    When I POST to "/hubs/{hubId}/shifts/availability" with:
      | id        | a valid UUID |
      | startDate | "2026-07-01"  |
      | endDate   | "2026-07-07"  |
    Then the response status should be 200
    And the response body "startDate" should equal "2026-07-01"
    And the response body "endDate" should equal "2026-07-07"

  Scenario: List my availability blocks
    Given I have an availability block from 2026-07-01 to 2026-07-07
    When I GET "/hubs/{hubId}/shifts/availability/my"
    Then the response status should be 200
    And the response body "blocks" should be an array
    And the response body "blocks" should contain my block

  Scenario: Delete an availability block
    Given I have an availability block
    When I DELETE "/hubs/{hubId}/shifts/availability/{blockId}"
    Then the response status should be 200
    And the response body "ok" should be true

  Scenario: Admin can list all availability blocks by date range
    Given I am authenticated as an admin
    And a volunteer has an availability block in 2026-07-01 to 2026-07-31
    When I GET "/hubs/{hubId}/shifts/availability?from=2026-07-01&to=2026-07-31"
    Then the response status should be 200
    And the response body "blocks" should be an array

  Scenario: Reject invalid date range (start after end)
    When I POST to "/hubs/{hubId}/shifts/availability" with:
      | id        | a valid UUID |
      | startDate | "2026-07-10"  |
      | endDate   | "2026-07-01"  |
    Then the response status should be 400

  Scenario: Create availability block with encrypted reason
    When I POST to "/hubs/{hubId}/shifts/availability" with:
      | id              | a valid UUID        |
      | startDate       | "2026-08-01"         |
      | endDate         | "2026-08-05"         |
      | encryptedReason | "encrypted-reason"  |
    Then the response status should be 200
    And the response body "encryptedReason" should not be null
