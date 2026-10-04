@backend
Feature: Entity System Unification
  Events are records. Entity type templates provide preconfigured starting points.
  Date and location fields use blind indexes for server-side filtering without
  revealing cleartext values.

  # @fixme: catalog endpoint returns 14 uncategorised templates, not the 4 builtin ones this expects — #1204
  @templates @fixme
  Scenario: List builtin entity type templates
    Given I am authenticated as admin
    When I request GET "/settings/cms/templates"
    Then the response should contain 4 templates
    And the template list should include a template with category "event"
    And the template list should include a template with category "case"

  @templates
  Scenario: Apply event template creates entity type with date fields
    Given I am authenticated as admin
    And case management is enabled
    When I apply the builtin template "builtin:event"
    Then an entity type with category "event" should be created
    And that entity type should have a field named "start_date" with indexType "date"
    And that entity type should have a field named "location" with indexType "location"

  @templates
  Scenario: Template application is idempotent within a hub
    Given I am authenticated as admin
    And the builtin template "builtin:event" has been applied
    When I apply the builtin template "builtin:event"
    Then only one entity type with templateId "builtin:event" should exist

  @blind-index @date
  Scenario: Date blind index tokens enable month-level filtering
    Given case management is enabled
    And an event entity type exists with start_date field (indexType=date)
    And a record exists with start_date blind indexes for "2026-05"
    And a record exists with start_date blind indexes for "2026-06"
    When I filter records by blindIndexToken "month:2026-05" on field "start_date"
    Then I should receive 1 record
    And the server should not have seen the plaintext date

  # @wip: unbound, and the Given creates the role without assigning it to any user — the
  # request then goes out as admin, so binding the wording alone would pass vacuously — #1198
  @permission-aliasing @wip
  Scenario: events:read permission maps to cases:read
    Given a user has permission "events:read" but not "cases:read"
    When the user requests GET /api/records
    Then the request should be permitted
    And the audit log should show permission alias "events:read -> cases:read"

