@desktop
Feature: Setup Wizard
  As a new admin
  I want to configure the hotline through a guided wizard
  So that the system is set up correctly for my organization

  Background:
    Given I am logged in as an admin

  Scenario: Wizard displays on first launch
    When I navigate to the setup wizard
    Then I should see "Setup Wizard"
    And I should see "Name Your Hotline"
    And the hotline name input should be visible
    And the "Next" button should be disabled
    And the "Back" button should be disabled

  Scenario: Step 1 - fill identity and advance to channels
    When I navigate to the setup wizard
    And I fill in the hotline name
    And I fill in the organization name
    Then the "Next" button should be enabled
    When I click "Next"
    Then I should see "Choose Communication Channels"

  Scenario: Step 2 - channel selection prevents advancing without selection
    Given I am on the channels step
    Then I should see "Please select at least one channel"
    And the "Next" button should be disabled
    When I select the "Reports" channel
    Then the error message should disappear
    And the "Next" button should be enabled

  Scenario: Step 2 - select multiple channels
    Given I am on the channels step
    When I select the "Voice Calls" channel
    And I select the "SMS" channel
    Then both channels should be marked as selected
    And other channels should not be selected

  Scenario: Step 2 - clicking a selected channel deselects it
    Given I am on the channels step
    When I select the "Voice Calls" channel
    And I click the "Voice Calls" channel again
    Then the channel should be deselected
    And the validation error should reappear

  Scenario: Step 3 - skip button navigates forward
    Given I am on the providers step
    Then the "Skip" button should be visible
    When I click "Skip"
    Then I should see "Quick Settings"

  Scenario: Step 3 - no providers needed for Reports only
    Given I selected only "Reports" on the channels step
    When I advance to the providers step
    Then I should see "No external providers needed"

  Scenario: Step 3 - provider form shows for Voice Calls
    Given I selected "Voice Calls" on the channels step
    When I advance to the providers step
    Then I should see "Voice & SMS Provider"
    And I should see "Twilio"
    And I should see a "Test Connection" button
    And I should see a "Save Provider" button

  Scenario: Step 4 - voice settings appear when Voice is selected
    Given I selected "Voice Calls" and advanced to settings step
    Then I should see "Voice Call Settings"
    And I should see "Queue Timeout (seconds)"
    And I should see "Voicemail"

  Scenario: Step 4 - report settings appear when Reports is selected
    Given I selected "Reports" and advanced to settings step
    Then I should see "Report Settings"
    And I should see "Default Categories"

  Scenario: Step 4 - messaging settings appear when SMS is selected
    Given I selected "SMS" and advanced to settings step
    Then I should see "Messaging Settings"
    And I should see "Auto-Response Template"

  Scenario: Step 5 - summary displays configured values
    Given I have completed all wizard steps
    Then I should see "Review & Launch"
    And I should see the configured hotline name
    And I should see the selected channels
    And I should see a "Launch Hotline" button
    And the "Next" button should not be visible
    And the "Back" button should not be visible

  # Inviting comes after launch: an invite admits someone into a hub, and the
  # hub only exists once setup completes (#2194).
  Scenario: Step 6 - after launch, invite a volunteer into the new hub
    Given I have launched the hotline from the setup wizard
    When I fill in the volunteer name
    And I fill in the volunteer phone
    And I choose the volunteer role in the form
    Then the "Generate Invite" button should be enabled
    When I click "Generate Invite"
    Then I should see "Generated Invites"
    And the volunteer name should appear with an invite code
    And the invite should name the hub the wizard launched and the role chosen
    And the "Back" button should not be visible

  Scenario: Step 1 - next disabled with empty hotline name
    When I navigate to the setup wizard
    Then the "Next" button should be disabled
    When I type a hotline name
    Then the "Next" button should be enabled
    When I clear the hotline name
    Then the "Next" button should be disabled

  Scenario: Back navigation returns to previous steps
    Given I have advanced to the providers step
    When I click "Back"
    Then I should see "Choose Communication Channels"
    And the previously selected channel should still be selected
    When I click "Back"
    Then I should see "Name Your Hotline"
    And the previously entered hotline name should still be filled

  Scenario: Complete setup - full flow to dashboard
    When I complete the entire setup wizard
    And I click "Launch Hotline"
    And I click "Go to Dashboard"
    Then I should be redirected to the dashboard
