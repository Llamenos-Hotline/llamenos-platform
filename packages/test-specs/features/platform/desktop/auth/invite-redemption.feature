@desktop
Feature: Invite a volunteer and redeem the invite on a fresh desktop install
  The admin copies an invite link built on the hub's own address — never the
  desktop webview's origin, which in a packaged build is the Tauri asset
  protocol and means nothing on another machine. The volunteer either pastes
  that link (or the bare code) into the app, or clicks a
  `llamenos://hub-invite?code=` deep link that the desktop shell hands to the
  running app. A fresh install has no server configured, so the server address
  is confirmed (pre-filled with the hosted default) before the code, a bearer
  token, is ever sent anywhere.

  The volunteer scenarios drive the real UI from the first screen a fresh
  install shows: the server address is entered through the first-run form
  (never pre-seeded), and the code arrives the way a volunteer's would — pasted
  into the code-entry screen reached from the login screen, or delivered by the
  OS as a deep link (simulated at the IPC boundary, mirroring
  apps/desktop/src/deep_link.rs) — never put in the URL by the test.

  Scenario: The admin copies an invite link on the hub's own address
    Given I am logged in as an admin
    And the desktop app is now simulating a packaged build connected to its loopback address
    And I navigate to the "Volunteers" page
    When I create an invite for a new volunteer
    And I copy the new invite link
    Then the clipboard should hold the invite link on the configured server's address

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
    And the invited volunteer should now be a member of the invite's hub

  Scenario: Volunteer pastes the invite link and finishes onboarding
    Given an admin has created an invite for a new volunteer
    And the desktop app is simulating a packaged build with no server configured
    When I load the app
    And I replace the server address with this app's backend and connect
    And I choose to enter an invite code
    And I paste the invite link for this server
    And I submit the invite code
    Then I should see the welcome screen for the invited volunteer
    When I create my PIN and save my recovery key
    Then I should reach profile setup
    And the server should report the invite as already used
    And the invited volunteer should now be a member of the invite's hub

  Scenario: An invite link for a different server is refused without sending the code
    Given an admin has created an invite for a new volunteer
    And the desktop app is simulating a packaged build with no server configured
    When I load the app
    And I replace the server address with this app's backend and connect
    And I choose to enter an invite code
    And I paste an invite link for a different server
    And I submit the invite code
    Then I should see an invite code error naming the other server
    And no invite code should have been sent to the server
    And the server should still report the invite as unused

  Scenario: Clicking an invite link while the app is open goes straight to redemption
    Given an admin has created an invite for a new volunteer
    And the desktop app is simulating a packaged build with no server configured
    When I load the app
    And I replace the server address with this app's backend and connect
    Then I should be on the login screen
    When the volunteer clicks the invite deep link
    Then I should see the welcome screen for the invited volunteer
    When I create my PIN and save my recovery key
    Then I should reach profile setup
    And the server should report the invite as already used
    And the invited volunteer should now be a member of the invite's hub

  Scenario: An invite link that launched the app goes straight to redemption
    Given an admin has created an invite for a new volunteer
    And the desktop app is simulating a packaged build with no server configured
    When I load the app
    And I replace the server address with this app's backend and connect
    And the app is relaunched by the invite deep link
    Then I should see the welcome screen for the invited volunteer

  Scenario: An invite link opened while signed in leaves the signed-in account alone
    Given an admin has created an invite for a new volunteer
    And I am logged in as an admin
    When the volunteer clicks the invite deep link
    Then I should be told to sign out before redeeming the invite
    And I should still be signed in away from the redemption screen
    And the server should still report the invite as unused

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
