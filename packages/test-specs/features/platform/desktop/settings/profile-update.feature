@desktop
Feature: Profile update sends only what changed
  Saving the profile must not overwrite fields the user did not touch,
  so a change made on another device is not silently reverted (#1315).

  Scenario: Saving a phone number does not resend the display name
    Given I am logged in as an admin
    When I navigate to the "Settings" page
    And I enter a valid phone number
    Then saving the profile should send only the phone number
