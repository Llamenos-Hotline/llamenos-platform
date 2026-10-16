@desktop @ios @android
Feature: Ban Management
  As an admin
  I want to manage a ban list of phone numbers
  So that abusive callers can be blocked

  # ── Desktop/Mobile: Ban List UI ─────────────────────────────────

  Rule: Desktop and mobile ban management UI

    Background:
      Given I am logged in as an admin
      And I navigate to the "Ban List" page

    Scenario: Ban list page loads with heading and buttons
      Then I should see the "Ban List" heading
      And I should see a "Ban Number" button
      And I should see an "Import" button

    Scenario: Ban list shows bans or empty state
      Then I should see bans or the "No banned numbers" message

    Scenario: Add ban with phone and reason
      When I click the "Ban Number" button
      And I fill in the phone number
      And I fill in the reason with "Spam caller"
      And I click "Save"
      Then the phone number should appear in the ban list

    Scenario: Ban shows date
      When I add a ban with reason "Date check"
      Then the ban entry should contain the current year

    Scenario: Remove ban with confirmation
      Given a ban exists
      When I click "Remove" on the ban
      Then I should see a confirmation dialog
      When I click "Unban" in the dialog
      Then the dialog should close
      And the ban should no longer appear in the list

    Scenario: Cancel ban removal
      Given a ban exists
      When I click "Remove" on the ban
      Then I should see a confirmation dialog
      When I click "Cancel" in the dialog
      Then the dialog should close
      And the ban should still appear in the list

    Scenario: Cancel add ban form
      When I click the "Ban Number" button
      Then the phone number input should be visible
      When I click "Cancel"
      Then the phone number input should not be visible

    Scenario: Phone validation rejects invalid numbers
      When I click the "Ban Number" button
      And I fill in the phone number with "+1234567890123456789"
      And I click "Save"
      Then I should see "invalid phone"

    Scenario: Multiple bans display in list
      When I add two bans with different phone numbers
      Then both phone numbers should appear in the ban list
      And both ban reasons should be visible

    Scenario: Bulk import form opens and closes
      When I click the "Import" button
      Then I should see "Paste phone numbers"
      When I click "Cancel"
      Then I should not see "Paste phone numbers"

    Scenario: Bulk import adds multiple bans
      When I click the "Import" button
      And I paste two phone numbers in the textarea
      And I fill in the reason with "Bulk ban reason"
      And I click "Submit"
      Then both phone numbers should appear in the ban list

    Scenario: Bulk import rejects invalid phones
      When I click the "Import" button
      And I paste invalid phone numbers in the textarea
      And I click "Submit"
      Then I should see "invalid phone"

    Scenario: Volunteer cannot access ban list
      Given a volunteer exists
      When the volunteer logs in and navigates to "/bans"
      Then they should see "Access Denied"

  # ── Backend: Ban check on incoming call ───────────────────────────

  Rule: Backend ban check on incoming call

    @backend
    Scenario: Incoming call from banned number is rejected via API
      And "+15559999999" is on the ban list
      When a call arrives from "+15559999999"
      Then the call is rejected

    @backend
    Scenario: Incoming call from non-banned number proceeds via API
      And 1 volunteers are on shift
      When a call arrives from "+15550001111"
      Then the call status is "ringing"
