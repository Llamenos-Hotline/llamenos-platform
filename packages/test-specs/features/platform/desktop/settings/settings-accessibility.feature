@desktop
Feature: Settings accessibility
  As a volunteer or admin who cannot use a mouse
  I want every settings section to open from the keyboard with its state announced
  So that I can reach every setting

  Scenario: Sections are reachable and operable by keyboard alone
    Given I am logged in as an admin
    When I navigate to the "Settings" page
    And I tab to the "Profile" section header
    Then the "Profile" section header should report itself expanded
    When I press "Enter" on the focused element
    Then the profile section should collapse
    And the "Profile" section header should report itself collapsed
    When I press "Space" on the focused element
    Then the profile section should expand
    And the "Profile" section header should report itself expanded

  Scenario: Spoken language chips expose their selected state
    Given I am logged in as an admin
    When I navigate to the "Settings" page
    Then toggling a spoken language chip should flip its pressed state
