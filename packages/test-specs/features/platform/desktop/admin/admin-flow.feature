@desktop
Feature: Admin Flow
  As an admin
  I want to navigate and manage the admin panel
  So that I can oversee all hotline operations

  Background:
    Given I am logged in as an admin

  Scenario: Dashboard shows admin navigation links
    Then I should see "Admin" in the navigation
    And I should see "Volunteers" in the navigation
    And I should see "Shifts" in the navigation
    And I should see "Ban List" in the navigation
    And I should see "Call History" in the navigation
    And I should see "Audit Log" in the navigation
    And I should see "Hub Settings" in the navigation
    And I should see "Settings" in the navigation

  Scenario: Volunteer CRUD — add and delete volunteer
    When I navigate to the "Volunteers" page
    And I add a new volunteer with a unique name and phone
    Then I should see the generated device key
    When I close the device key card
    Then the volunteer should appear in the list
    When I delete the volunteer
    Then the volunteer should be removed from the list

  Scenario: Shift creation
    When I navigate to the "Shifts" page
    And I create a new shift with a unique name
    Then the shift should appear in the list

  Scenario: Shift edit
    When I navigate to the "Shifts" page
    And I create a new shift with a unique name
    And I edit the shift with a new name
    Then the updated shift name should appear

  Scenario: Shift delete
    When I navigate to the "Shifts" page
    And I create a new shift with a unique name
    And I delete the shift
    Then the shift should no longer appear

  Scenario: Ban list management — add ban
    When I navigate to the "Ban List" page
    And I ban a unique phone number with reason "E2E test ban"
    Then the banned phone number should appear
    And I should see "E2E test ban"

  Scenario: Ban removal
    When I navigate to the "Ban List" page
    And I ban a unique phone number with reason "To remove"
    And I remove the ban for that phone number
    Then the phone number should no longer appear

  Scenario: Phone validation rejects bad numbers
    When I navigate to the "Volunteers" page
    And I try to add a volunteer with an invalid phone number
    Then I should see an invalid phone error

  Scenario: Audit log shows entries
    When I navigate to the "Audit Log" page
    Then I should see the "Audit Log" heading

  Scenario: Admin settings page loads with all sections
    When I navigate to the "Hub Settings" page
    Then I should see the "Hub Settings" heading
    And I should see the "Transcription" heading
    And I should see the "Spam Mitigation" heading
    When I expand the "Spam Mitigation" section
    Then I should see "Voice CAPTCHA"
    And I should see "Rate Limiting"

  Scenario: Admin settings toggles work
    When I navigate to the "Hub Settings" page
    And I expand the "Transcription" section
    Then I should see at least one toggle switch

  Scenario: Call history page loads
    When I navigate to the "Call History" page
    Then I should see the "Call History" heading

  Scenario: Call history search form works
    When I navigate to the "Call History" page
    And I search for a phone number in call history
    Then I should see the clear filters button
    When I click the clear filters button
    Then the clear filters button should not be visible

  Scenario: Notes page loads
    When I navigate to the "Notes" page
    Then I should see the "Call Notes" heading
    And I should see "encrypted end-to-end"

  Scenario: Language switching works
    When I switch the language to Espanol
    Then I should see the "Panel" heading
    And I should see "Notas" in the navigation
    When I switch the language back to English
    Then I should see the "Dashboard" heading

  Scenario: Admin settings shows status summaries when collapsed
    When I navigate to the "Hub Settings" page
    Then the telephony provider card should be visible
    And the transcription card should be visible
    And at least one status summary should be visible

  Scenario: Logout works
    When I log out
    Then I should see the "Sign in" heading
