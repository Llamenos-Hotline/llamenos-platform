@desktop
Feature: The shift editor says which time zone it is in
  The times typed into the shift form are wall-clock values in the hub's time zone
  (#1054), so the editor must state that zone. A schedule the admin cannot tell the
  zone of is how a 09:00 shift ends up live at the wrong hour. iOS and Android show it
  once #2625 lands, at which point they are tagged here.

  Scenario: The shift form states the hub's time zone
    Given I am logged in as an admin
    And I navigate to the "Shifts" page
    When I click the "Create Shift" button
    Then the shift form should state the hub's time zone
