@desktop
Feature: Settings toggle confirmation dialogs
  Admins confirm before toggling destructive settings
  to prevent accidental changes to live system configuration.

  Background:
    Given I am logged in as admin

  Scenario: Toggling a live setting shows a confirmation dialog
    When I navigate to the "Hub Settings" page
    And I expand the "Spam Mitigation" section
    And I click the spam mitigation toggle
    Then I should see a confirmation dialog
    And I can cancel without applying the change

  # Regression coverage for #1130: the admin sidebar route
  # (/admin/spam-protection) renders a *different* component than the
  # "Hub Settings" page above, and it used to re-read settings from the
  # server instead of PATCHing them — the switch looked like it worked
  # and then reverted on reload. This must go through the sidebar route
  # specifically; a scenario that only flips the switch and reads it back
  # would not catch that bug.
  Scenario: Toggling CAPTCHA through the admin sidebar route persists after reload
    When I navigate to "/admin/spam-protection"
    And I toggle the CAPTCHA setting and confirm the change
    Then the CAPTCHA setting change should persist after a reload

  Scenario: Command palette opens with keyboard shortcut
    When I press "Control+k"
    Then I should see the command palette
    And it should be focusable and searchable
