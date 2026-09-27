@backend
Feature: CMS Events — Unified Entity System
  Events are CMS records whose entity type has category='event'.
  The /api/events routes are deprecated and return 301 redirects.
  Event data uses 3-tier E2EE like all other records.

  # @wip: Location-header step has no backend definition — #1198
  @events @deprecated-api @wip
  Scenario: Deprecated /api/events returns 301 redirect
    Given case management is enabled
    When a client sends GET /api/events
    Then the response status should be 301
    And the response Location header should contain /api/records
    And the response should include a Deprecation header

  @events @entity-system
  Scenario: Create event record via /api/records with event entity type
    Given case management is enabled
    And an entity type with category "event" exists for the hub
    When the admin creates a record with that entity type
    Then the record should be persisted
    And the record entity type category should be "event"
    And the record should use 3-tier encryption (summary fields pii)

  @events @blind-index
  Scenario: Filter event records by date blind index token
    Given case management is enabled
    And an entity type with category "event" exists for the hub
    And a record exists with blindIndexes containing "month:2026-05" for field "start_date"
    And a record exists with blindIndexes containing "month:2026-06" for field "start_date"
    When the admin lists records with blindIndexToken "month:2026-05" and field "start_date"
    Then the result should contain 1 record
    And that record's blind indexes should contain "month:2026-05"

  # Events shown in the UI are case records whose entity type has category "event".
  # The event link endpoints must accept those records, scoped to the caller's hub (#789).
  @events @event-links
  Scenario: Link a case record to an event-category record
    Given case management is enabled
    And an event entity type "Protest" exists
    And an event record of type "Protest" exists
    And a record of type "Arrest" exists
    When the admin links the record to the event record
    Then the event record should have 1 linked record

  @events @event-links
  Scenario: Link a report to an event-category record
    Given case management is enabled
    And an event entity type "Protest" exists
    And an event record of type "Protest" exists
    And a report exists
    When the admin links the report to the event record
    Then the event record should have 1 linked report

  @events @event-links
  Scenario: Cannot link a case record to an event record in another hub
    Given case management is enabled
    And a record of type "Arrest" exists
    And an event record exists in another hub
    When the admin links the record to the other hub's event record
    Then the response status should be 404

  @events @event-links
  Scenario: Cannot link a case record to a record whose entity type is not an event
    Given case management is enabled
    And a record of type "Arrest" exists
    And a record of type "Note" exists
    When the admin links the record to the non-event record
    Then the response status should be 404
