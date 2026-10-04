@android
Feature: Hub switching
  Users can switch between hubs they belong to.

  Background:
    Given the app is launched with two test hubs

  Scenario: Switching hubs changes active hub indicator
    Given I am on the hub management screen
    When I tap the second hub in the list
    Then the second hub shows the active indicator
    And the first hub no longer shows the active indicator

  Scenario: Switching hubs reloads hub-scoped data
    Given I am on the hub management screen
    When I tap the second hub in the list
    And I navigate to the notes screen
    Then the notes screen loads without error

  # @wip: needs a real push wake path to drive on Android — blocked on #955
  @android @security @wip
  Scenario: Background push notification does not switch active hub
    Given I am authenticated and hub "hub-A" is the active hub
    And I am also a member of hub "hub-B"
    When an incoming call FCM push notification arrives for hub "hub-B"
    Then hub "hub-A" remains the active hub
    And the call notification is shown without switching hub context
