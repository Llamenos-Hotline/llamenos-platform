@desktop
Feature: Login Page Restore
  As a user
  I want the login page to handle both fresh installs and returning users
  So that I can access the app whether I'm new or returning

  Scenario: Fresh install shows device key input and Log in button
    Given I am on the login screen
    Then I should see the device key import input field
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

  Scenario: Recovery options switches to recovery view
    Given I have a stored encrypted key
    When I visit the login page
    Then I should see the PIN digit inputs
    When I click "Recovery Options"
    Then I should see the device key import input field
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

  # Moved here from core/auth-login.feature (#2675). That file is headed `@ios @android`, which every
  # scenario inherits, so "@desktop" at the scenario could never have kept it off the mobile suites.
  # The device key field exists only on desktop: neither mobile login screen has a `device-key-input`
  # or `device-key-error` element (they have hub-url-input, invite-code-input, create-identity).
  # The mobile analogue is "typing clears login-error". Android does - AuthViewModel.updateHubUrl and
  # updateInviteCode reset `error`. iOS does not - AuthViewModel.errorMessage is cleared only when
  # createNewIdentity starts, never when hubURL or inviteEnrollment.input changes.
  @regression
  Scenario: Error clears when typing in device key field
    Given the app is freshly installed
    And I am on the login screen
    When I tap "Log in"
    And I should see an error message
    And I start typing in the device key field
    Then the error should disappear
