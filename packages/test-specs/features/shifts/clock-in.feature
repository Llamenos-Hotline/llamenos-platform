@backend @desktop @ios
Feature: Shift Clock-in and Heartbeat
  As a volunteer
  I want to clock in and maintain a heartbeat
  So that I am included in call routing while on shift

  Background:
    Given I am authenticated as a volunteer
    And I have an active hub

  Scenario: Clock in to a shift
    When I POST to "/hubs/{hubId}/shifts/clock-in"
    Then the response status should be 200
    And the response body "ok" should be true

  Scenario: Clock out from a shift
    Given I am clocked in
    When I POST to "/hubs/{hubId}/shifts/clock-out"
    Then the response status should be 200
    And the response body "ok" should be true

  Scenario: Send a heartbeat while clocked in
    Given I am clocked in
    When I POST to "/hubs/{hubId}/shifts/heartbeat"
    Then the response status should be 200
    And the response body "ok" should be true

  Scenario: Admin can see active volunteers
    Given I am authenticated as an admin
    And volunteer "vol-1" is clocked in
    When I GET "/hubs/{hubId}/shifts/active"
    Then the response status should be 200
    And the response body "activeShifts" should be an array
    And the response body "activeShifts" should contain an entry with pubkey "vol-1"

  Scenario: Clocking in twice is idempotent
    Given I am clocked in
    When I POST to "/hubs/{hubId}/shifts/clock-in" again
    Then the response status should be 200
    And the response body "ok" should be true
