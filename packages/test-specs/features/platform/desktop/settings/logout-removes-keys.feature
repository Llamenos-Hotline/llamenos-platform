@desktop
Feature: Settings Log Out removes the stored device keys
  The Log Out confirmation tells the user their encrypted keys will be removed from
  this device. That has to be true: the next person at the machine must not be
  offered the previous user's PIN pad (#2110).

  @regression
  Scenario: Confirm logout removes the stored device keys
    Given I am authenticated
    And I am on the settings screen
    When I tap "Log Out"
    And I tap "Confirm"
    Then I should return to the login screen
    And no stored keys should remain
    And the crypto service should be locked
