@desktop
Feature: Invite a volunteer and redeem the invite on a fresh desktop install
  The admin sends the volunteer a bare invite code over Signal; the volunteer
  pastes it into the app — nothing is clicked. A fresh install has no server
  configured, so the server address is confirmed (pre-filled with the hosted
  default) before the code, a bearer token, is ever sent anywhere.

  The volunteer scenarios drive the real UI from the first screen a fresh
  install shows: the server address is entered through the first-run form
  (never pre-seeded), and the code is pasted into the code-entry screen
  reached from the login screen (never put in the URL).

  Scenario: The admin copies the bare invite code, ready to paste into Signal
    Given I am logged in as an admin
    And I navigate to the "Volunteers" page
    When I create an invite for a new volunteer
    And I copy the new invite code
    Then the clipboard should hold only the invite code

  Scenario: Volunteer pastes an invite code and finishes onboarding
    Given an admin has created an invite for a new volunteer
    And the desktop app is simulating a packaged build with no server configured
    When I load the app
    Then the server address field is pre-filled with the hosted default
    When I replace the server address with this app's backend and connect
    Then I should be on the login screen
    When I choose to enter an invite code
    Then the invite code screen names the server the code will be sent to
    When I paste the invite code in upper case, wrapped in spaces and line breaks
    And I submit the invite code
    Then I should see the welcome screen for the invited volunteer
    When I create my PIN and save my recovery key
    Then I should reach profile setup
    And the server should report the invite as already used
    And the invited volunteer should now exist on the server

  Scenario: An invite code the server never issued is refused on the entry screen
    Given an admin has created an invite for a new volunteer
    And the desktop app is simulating a packaged build with no server configured
    When I load the app
    And I replace the server address with this app's backend and connect
    And I choose to enter an invite code
    And I paste an invite code the server never issued
    And I submit the invite code
    Then I should see an invite code error on the code entry screen
    And the server should still report the invite as unused

  Scenario: Text that is not an invite code is refused without contacting the server
    Given an admin has created an invite for a new volunteer
    And the desktop app is simulating a packaged build with no server configured
    When I load the app
    And I replace the server address with this app's backend and connect
    And I choose to enter an invite code
    And I paste "not-an-invite-code" as the invite code
    And I submit the invite code
    Then I should see an invite code error on the code entry screen
    And no invite code should have been sent to the server
