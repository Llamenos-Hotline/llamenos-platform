@backend @desktop @ios
Feature: Shift Join/Leave Requests
  As a volunteer
  I want to request to join or leave shifts
  So that admins can approve schedule changes

  Background:
    Given I have an active hub
    And a shift exists in the hub with id "shift-1"

  Scenario: Volunteer submits a join request
    Given I am authenticated as a volunteer
    When I POST to "/hubs/{hubId}/shifts/requests" with:
      | shiftId | "shift-1" |
      | type    | "join"     |
    Then the response status should be 200
    And the response body "status" should equal "pending"
    And the response body "type" should equal "join"

  Scenario: Volunteer submits a leave request
    Given I am authenticated as a volunteer
    When I POST to "/hubs/{hubId}/shifts/requests" with:
      | shiftId | "shift-1" |
      | type    | "leave"    |
    Then the response status should be 200
    And the response body "type" should equal "leave"

  Scenario: Admin lists pending requests
    Given I am authenticated as an admin
    And a join request exists with status "pending"
    When I GET "/hubs/{hubId}/shifts/requests"
    Then the response status should be 200
    And the response body "requests" should be an array

  Scenario: Admin approves a request
    Given I am authenticated as an admin
    And a pending join request exists for shift "shift-1"
    When I POST to "/hubs/{hubId}/shifts/requests/{requestId}/approve" with:
      | status | "approved" |
    Then the response status should be 200
    And the response body "status" should equal "approved"

  Scenario: Admin rejects a request
    Given I am authenticated as an admin
    And a pending join request exists for shift "shift-1"
    When I POST to "/hubs/{hubId}/shifts/requests/{requestId}/reject" with:
      | status | "denied" |
    Then the response status should be 200
    And the response body "status" should equal "denied"

  Scenario: Duplicate pending request is rejected
    Given I am authenticated as a volunteer
    And I already have a pending join request for "shift-1"
    When I POST to "/hubs/{hubId}/shifts/requests" with:
      | shiftId | "shift-1" |
      | type    | "join"     |
    Then the response status should be 409

  Scenario: Volunteer cannot approve requests
    Given I am authenticated as a volunteer
    And a pending join request exists
    When I POST to "/hubs/{hubId}/shifts/requests/{requestId}/approve"
    Then the response status should be 403
