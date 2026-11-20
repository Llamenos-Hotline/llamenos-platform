@backend @desktop @ios
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
    Given I have an availability block from "2026-07-01" to "2026-07-07"
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
    And a volunteer has an availability block in "2026-07-01" to "2026-07-31"
    When I GET "/hubs/{hubId}/shifts/availability?from=2026-07-01&to=2026-07-31"
    Then the response status should be 200
    And the response body "blocks" should be an array

  Scenario: Reject invalid date range (start after end)
    When I POST to "/hubs/{hubId}/shifts/availability" with:
      | id        | a valid UUID |
      | startDate | "2026-07-10"  |
      | endDate   | "2026-07-01"  |
    Then the response status should be 400

  # #2777: the reason is a volunteer's personal circumstance. It is sealed on the
  # client to the volunteer and the hub's admins; the server stores ciphertext.
  Scenario: An availability reason is stored sealed, and an admin can open it
    When I save a reason "court date" sealed to myself and the hub admins
    Then the response status should be 200
    And the stored reason is ciphertext an admin opens as "court date"

  Scenario: An availability reason sent as the typed text is refused
    When I save a reason "medical appointment" as plain text
    Then the response status should be 400

  Scenario: An availability reason no admin can open is refused
    When I save a reason "childcare" sealed only to myself
    Then the response status should be 422
