@desktop
Feature: Login Page Restore
  As a user
  I want the login page to handle both fresh installs and returning users
  So that I can access the app whether I'm new or returning

  # @wip: step "I should see the device key input" has no desktop definition — #1195
  @wip
  Scenario: Fresh install shows device key input and Log in button
    Given I am on the login screen
    Then I should see the device key input
    And I should see the "Log in" button

  Scenario: Fresh install shows backup file upload area
    Given I am on the login screen
    Then I should see the backup file upload area

  Scenario: Invalid device key shows error
    Given I am on the login screen
    When I enter "not-a-valid-key" in the device key field
    And I click "Log in"
    Then I should see "invalid"

  Scenario: Empty device key shows error
    Given I am on the login screen
    When I click "Log in"
    Then I should see "invalid"

  Scenario: Stored key shows PIN digit inputs
    Given I have a stored encrypted key
    When I visit the login page
    Then I should see the PIN digit inputs

  Scenario: Stored key shows Recovery options button
    Given I have a stored encrypted key
    When I visit the login page
    Then I should see the "Recovery Options" button

  # @wip: step "I should see the device key input" has no desktop definition — #1195
  @wip
  Scenario: Recovery options switches to recovery view
    Given I have a stored encrypted key
    When I visit the login page
    Then I should see the PIN digit inputs
    When I click "Recovery Options"
    Then I should see the device key input
    And I should see the "Log in" button

  Scenario: Language selector available on login
    Given I am on the login screen
    Then I should see the language selector

  Scenario: Theme toggles work on login
    Given I am on the login screen
    Then I should see the theme toggle buttons

  Scenario: Security note is visible on login
    Given I am on the login screen
    Then I should see "key never leaves your device"
