@backend
Feature: Hub incidents — every automatic defence is visible to the people responsible for it
  The operator accepted refusing over-limit callers only on the condition that
  the hub's responsible people know the incident is happening. An incident is
  an aggregate (counts, never callers), reaches exactly the members whose roles
  grant the category's permission, and tells everyone else only that something
  changed. The producer here is the test-only one; real defences wire their
  own signals in later bundles.

  Background:
    Given an isolated hub for incident scenarios
    And a hub member whose role grants only "settings:manage-spam"
    And a hub member whose role grants only "telephony:manage-providers"
    And a hub volunteer with no incident permission

  @backend
  Scenario: A spam incident reaches the spam permission holder and nobody else
    When the test producer signals 15 "spam" "fail" events
    Then the "settings:manage-spam" holder sees one open "spam" incident counting 15 "fail"
    And the "telephony:manage-providers" holder sees no incidents
    And the volunteer sees no incidents

  @backend
  Scenario: Each holder sees only their own category
    When the test producer signals 3 "spam" "fail" events
    And the test producer signals 2 "provider-media" "delete_failed" events
    Then the "settings:manage-spam" holder sees only "spam" incidents
    And the "telephony:manage-providers" holder sees only "provider-media" incidents
    And the volunteer sees no incidents

  @backend
  Scenario Outline: Each category is reached by its permission
    Given a hub member whose role grants only "<permission>"
    When the test producer signals 1 "<category>" "<kind>" events
    Then the "<permission>" holder sees one open "<category>" incident counting 1 "<kind>"
    And the volunteer sees no incidents

    Examples:
      | category         | kind              | permission                 |
      | spam             | fail              | settings:manage-spam       |
      | provider-media   | delete_failed     | telephony:manage-providers |
      | erasure-deadline | overdue           | erasure:admin              |
      | ban-expiry       | expiring          | system:view-bans           |
      | routing          | nobody_would_ring | shifts:manage-fallback     |
      | provider-auth    | signature_invalid | telephony:manage-providers |
      | channel-disabled | sms               | hubs:configure             |

  @backend
  Scenario: A member without the permission learns only that an incident changed
    Given the volunteer is connected to the relay for the incident hub
    When the test producer signals 15 "spam" "fail" events
    Then the volunteer receives exactly one incident relay event
    And that relay event carries only an incident id and the state "opened"

  @backend
  Scenario: Fifty signals in one window notify once
    Given the volunteer is connected to the relay for the incident hub
    When the test producer signals 50 "spam" "fail" events
    Then the "settings:manage-spam" holder sees one open "spam" incident counting 50 "fail"
    And the volunteer receives exactly one incident relay event
    And the "settings:manage-spam" holder received exactly 1 incident push
    And the "telephony:manage-providers" holder received no incident push
    And the volunteer received no incident push

  @backend
  Scenario: The push is content-free
    When the test producer signals 15 "spam" "fail" events
    Then every incident push carries only the hub and the incident type
    And no incident push carries a number-shaped string

  @backend
  Scenario: A record-level kind is visible but wakes nobody
    When the test producer signals 4 "spam" "challenge" events
    Then the "settings:manage-spam" holder sees one open "spam" incident counting 4 "challenge"
    And no incident push went out for the incident hub

  @backend
  Scenario: A quiet incident closes and the people woken are told
    Given the volunteer is connected to the relay for the incident hub
    When the test producer signals 2 "spam" "fail" events
    And the incident closer runs 16 minutes later
    Then the "settings:manage-spam" holder sees no open incidents
    And the volunteer receives an incident relay event with the state "closed"
    And the "settings:manage-spam" holder received exactly 2 incident pushes

  @backend
  Scenario: Opening and closing are audited with counts and no identifiers
    When the test producer signals 2 "spam" "fail" events
    And the incident closer runs 16 minutes later
    Then the incident hub's audit log records "incidentOpened" and "incidentClosed" by the system
