@desktop @ios @android
Feature: Ban Management
  As an admin
  I want to manage a ban list of phone numbers
  So that abusive callers can be blocked

  # ── Desktop/Mobile: Ban List UI ─────────────────────────────────
  #
  # NOTE: each scenario states its own "logged in" + "navigate to Ban List" setup
  # inline instead of via a Rule-scoped Background. A Rule-scoped Background is
  # correctly excluded from the @backend Rule below by the real Gherkin/Cucumber
  # parser, but this repo's own packages/test-specs/tools/validate-coverage.ts
  # uses a naive line-based scanner that does not understand Rule-scoped
  # Background boundaries — it flattens Background: into "applies to every
  # scenario in the file" regardless of which Rule contains it. Keeping a shared
  # Background here would make the two @backend scenarios below permanently
  # report a false "missing step: I navigate to the Ban List page", however the
  # Rule blocks are ordered. Inlining removes the Background construct entirely,
  # so there is nothing left for that scanner to mis-scope.

  Rule: Desktop and mobile ban management UI

    Scenario: Ban list page loads with heading and buttons
      Given I am logged in as an admin
      And I navigate to the "Ban List" page
      Then I should see the "Ban List" heading
      And I should see a "Ban Number" button
      And I should see an "Import" button

    Scenario: Ban list shows bans or empty state
      Given I am logged in as an admin
      And I navigate to the "Ban List" page
      Then I should see bans or the "No banned numbers" message

    Scenario: Add ban with phone and reason
      Given I am logged in as an admin
      And I navigate to the "Ban List" page
      When I click the "Ban Number" button
      And I fill in the phone number
      And I fill in the reason with "Spam caller"
      And I click "Save"
      Then the phone number should appear in the ban list

    Scenario: Ban shows date
      Given I am logged in as an admin
      And I navigate to the "Ban List" page
      When I add a ban with reason "Date check"
      Then the ban entry should contain the current year

    Scenario: Remove ban with confirmation
      Given I am logged in as an admin
      And I navigate to the "Ban List" page
      And a ban exists
      When I click "Remove" on the ban
      Then I should see a confirmation dialog
      When I click "Unban" in the dialog
      Then the dialog should close
      And the ban should no longer appear in the list

    Scenario: Cancel ban removal
      Given I am logged in as an admin
      And I navigate to the "Ban List" page
      And a ban exists
      When I click "Remove" on the ban
      Then I should see a confirmation dialog
      When I click "Cancel" in the dialog
      Then the dialog should close
      And the ban should still appear in the list

    Scenario: Cancel add ban form
      Given I am logged in as an admin
      And I navigate to the "Ban List" page
      When I click the "Ban Number" button
      Then the phone number input should be visible
      When I click "Cancel"
      Then the phone number input should not be visible

    Scenario: Phone validation rejects invalid numbers
      Given I am logged in as an admin
      And I navigate to the "Ban List" page
      When I click the "Ban Number" button
      And I fill in the phone number with "+1234567890123456789"
      And I click "Save"
      Then I should see "invalid phone"

    Scenario: Multiple bans display in list
      Given I am logged in as an admin
      And I navigate to the "Ban List" page
      When I add two bans with different phone numbers
      Then both phone numbers should appear in the ban list
      And both ban reasons should be visible

    Scenario: Bulk import form opens and closes
      Given I am logged in as an admin
      And I navigate to the "Ban List" page
      When I click the "Import" button
      Then I should see "Paste phone numbers"
      When I click "Cancel"
      Then I should not see "Paste phone numbers"

    Scenario: Bulk import adds multiple bans
      Given I am logged in as an admin
      And I navigate to the "Ban List" page
      When I click the "Import" button
      And I paste two phone numbers in the textarea
      And I fill in the reason with "Bulk ban reason"
      And I click "Submit"
      Then both phone numbers should appear in the ban list

    Scenario: Bulk import rejects invalid phones
      Given I am logged in as an admin
      And I navigate to the "Ban List" page
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
      Given "+15559999999" is on the ban list
      When a call arrives from "+15559999999"
      Then the call is rejected

    @backend
    Scenario: Incoming call from non-banned number proceeds via API
      Given 1 volunteers are on shift
      When a call arrives from "+15550001111"
      Then the call status is "ringing"
