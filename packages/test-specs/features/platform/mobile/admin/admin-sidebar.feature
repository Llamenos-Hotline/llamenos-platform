@android
Feature: Admin Sidebar Navigation
  As an admin
  I want to use the sidebar drawer to navigate between admin sections
  So that I can quickly access different settings

  @android @regression
  Scenario: Admin sidebar toggle button is visible
    Given I am logged in as an admin
    And I navigate to admin settings with sidebar
    Then I should see the sidebar toggle button

  @android @regression
  Scenario: Sidebar drawer opens and shows nav items
    Given I am logged in as an admin
    And I navigate to admin settings with sidebar
    When I tap the sidebar toggle button
    Then I should see the admin sidebar drawer
    And I should see "This Hub" scope header
    And I should see hub-level nav items

  @android @regression
  Scenario: Sidebar drawer shows platform scope section
    Given I am logged in as an admin
    And I navigate to admin settings with sidebar
    When I tap the sidebar toggle button
    Then I should see "VERIFY B Forced Failure" scope header

  @android @regression
  Scenario: Tapping a sidebar item navigates to that section
    Given I am logged in as an admin
    And I navigate to admin settings with sidebar
    When I tap the sidebar toggle button
    And I tap the "call-settings" sidebar item
    Then the sidebar drawer should close
    And I should see the call settings section content

  @android @regression
  Scenario: Sidebar shows all expected hub-level items
    Given I am logged in as an admin
    And I navigate to admin settings with sidebar
    When I tap the sidebar toggle button
    Then I should see sidebar items for:
      | item              |
      | location-lookup   |
      | custom-fields     |
      | call-settings     |
      | transcription     |
      | spam-protection   |
      | phone-provider    |
      | bans              |
      | audit             |

  @android @regression
  Scenario: Navigating between sections updates content
    Given I am logged in as an admin
    And I navigate to admin settings with sidebar
    When I tap the sidebar toggle button
    And I tap the "spam-protection" sidebar item
    Then I should see spam protection section content
    When I tap the sidebar toggle button
    And I tap the "transcription" sidebar item
    Then I should see transcription section content
