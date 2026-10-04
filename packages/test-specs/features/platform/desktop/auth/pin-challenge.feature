@desktop
Feature: PIN Challenge (Re-auth Step-up)
  As an admin
  I want sensitive actions to require PIN re-verification
  So that even if someone gains access to my unlocked session, they cannot unmask PII

  Background:
    Given I am logged in as an admin
    # A hub member with a phone, so the toggle is on a row this scenario owns
    # rather than on some other scenario's user leaking into the hub's list
    And I have created a volunteer

  Scenario: Phone unmask requires PIN challenge
    When I navigate to the "Volunteers" page
    And I click the phone visibility toggle
    Then I should see the PIN challenge dialog
    When I enter the correct PIN
    Then the PIN challenge dialog should close
    And I should see the unmasked phone number

  Scenario: Wrong PIN shows error and dialog stays open
    When I navigate to the "Volunteers" page
    And I click the phone visibility toggle
    Then I should see the PIN challenge dialog
    When I enter a wrong PIN three times
    Then I should see a wrong PIN error message
    And the PIN challenge dialog should remain open

  Scenario: Cancel PIN challenge closes dialog
    When I navigate to the "Volunteers" page
    And I click the phone visibility toggle
    Then I should see the PIN challenge dialog
    When I click "Cancel"
    Then the PIN challenge dialog should close
    And I should still be on the volunteers page
