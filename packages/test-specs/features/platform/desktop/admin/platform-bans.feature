@desktop
Feature: Platform-Wide Ban Management
  As a super admin
  I want to manage platform-wide phone number bans
  So that malicious callers can be blocked across all hubs

  Background:
    Given I am logged in as an admin

  Scenario: Platform bans section renders in admin panel
    When I navigate to the admin "platform-bans" section
    Then I should see the platform bans list or empty state

  Scenario: Platform bans section shows create and bulk import buttons
    When I navigate to the admin "platform-bans" section
    Then I should see the platform bans create button
    And I should see the platform bans bulk import button

  Scenario: Create platform ban dialog opens on button click
    When I navigate to the admin "platform-bans" section
    And I click the platform bans create button
    Then I should see a dialog for entering a phone number and reason

  Scenario: Search functionality is available
    When I navigate to the admin "platform-bans" section
    Then I should see the platform bans search input
