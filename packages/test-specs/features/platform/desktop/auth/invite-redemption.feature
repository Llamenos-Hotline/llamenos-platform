@desktop
Feature: Invite Redemption Entry Point
  As a volunteer holding an invite code
  I want an in-app way to redeem it from the login screen
  So that I can join the hotline even though a packaged desktop app has no
  address bar, and the copied invite link may not resolve on this machine
  (#1128)

  Scenario: A volunteer redeems a real invite via the login screen's invite form
    Given I am logged in as an admin
    And I navigate to the "Volunteers" page
    When I create an invite for a new volunteer
    Then an invite link should be generated
    When the volunteer redeems their invite code from the login screen
    Then they should see a welcome screen with their name
    When the volunteer completes the onboarding flow
    Then they should arrive at the profile setup or dashboard

  Scenario: Redeeming a bad invite code from the login screen shows an error
    Given the app is freshly installed
    And no identity exists on the device
    When the app launches
    And I open the redeem invite form
    And I submit the invite code "not-a-real-code-123"
    Then I should see "Invalid invite"
