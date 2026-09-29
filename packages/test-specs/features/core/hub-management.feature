Feature: Hub Management
  Admins can create, list, and switch between hubs.
  Each hub is an independent organizational unit with its own
  volunteers, shifts, and case data.

  # --- Backend API scenarios ---

  @backend
  Scenario: Create and list hubs via API
    And the admin creates a hub via API
    When the admin lists all hubs
    Then the hub list should contain at least 1 hub
    And each hub should have a name and slug

  @backend
  Scenario: Create hub returns correct data
    When the admin creates a hub with name "Test Hub" and slug "test-hub"
    Then the response status should be 201
    And the created hub should have name "Test Hub"
    And the created hub should have slug "test-hub"
    And the hub should appear in the list

  # --- UI scenarios ---

  @desktop @ios @android
  Scenario: List hubs shows current hub
    Given I am logged in as an admin
    When I navigate to the "Hubs" page
    Then I should see at least one hub in the hub list

  @desktop @ios @android
  Scenario: Switch active hub
    Given I am logged in as an admin
    And multiple hubs exist
    When I navigate to the "Hubs" page
    And I select a different hub
    Then the active hub should change
    And the page data should reload for the new hub

  @desktop @ios @android
  Scenario: Create new hub
    Given I am logged in as an admin
    When I navigate to the "Hubs" page
    And I click the create hub button
    And I fill in the hub name with a unique name
    And I fill in the hub slug
    And I submit the create hub form
    Then a toast "Hub created" should appear
    And the new hub should appear in the hub list

  # @fixme: the admin hubs list shows no member count — #1311
  @desktop @ios @android @fixme
  Scenario: Hub list shows member count
    Given I am logged in as an admin
    When I navigate to the "Hubs" page
    Then each hub card should display a member count
