@backend @global-setting
Feature: Platform-Scoped Ban Management
  As a super admin
  I want to manage platform-wide bans
  So that abusive callers are blocked across all hubs

  # Platform bans (hubId IS NULL) are a genuinely global, non-hub-scoped resource —
  # unlike hub-scoped fixtures, they are NOT isolated by the per-scenario workerHub
  # fixture, so they would leak across the fullyParallel backend-bdd project's
  # concurrent workers. @global-setting routes this whole feature to the serial
  # backend-bdd-global-setting project (see playwright.config.ts); step definitions
  # in tests/steps/backend/platform-bans.steps.ts clean up everything they create
  # in an After hook, the same convention webauthn-policy.steps.ts uses.

  # ── Backend: Platform ban CRUD ──────────────────────────────────────

  @backend
  Scenario: Super admin lists platform bans (empty)
    Given a super admin user
    When the admin GETs "/bans/platform"
    Then the response status should be 200
    And the response should contain an empty bans list

  @backend
  Scenario: Super admin creates a platform ban
    Given a super admin user
    When the admin POSTs to "/bans/platform" with phone "+12125551234" and reason "Repeat offender"
    Then the response status should be 200
    And the response should contain ok true

  @backend
  Scenario: Created platform ban appears in list
    Given a super admin user
    And a platform ban exists for "+12125551234"
    When the admin GETs "/bans/platform"
    Then the response should contain 1 ban

  @backend
  Scenario: Super admin removes a platform ban
    Given a super admin user
    And a platform ban exists with id "ban-001"
    When the admin DELETEs "/bans/platform/ban-001"
    Then the response status should be 200
    And the response should contain ok true

  @backend
  Scenario: Delete returns 404 for unknown ban
    Given a super admin user
    When the admin DELETEs "/bans/platform/nonexistent-id"
    Then the response status should be 404

  # ── Backend: Bulk import ────────────────────────────────────────────

  @backend
  Scenario: Super admin bulk imports platform bans
    Given a super admin user
    When the admin POSTs to "/bans/platform/bulk" with 3 phone numbers
    Then the response status should be 200
    And the response should contain count 3

  @backend
  Scenario: Bulk import rejects invalid E.164 numbers
    Given a super admin user
    When the admin POSTs to "/bans/platform/bulk" with an invalid phone number
    Then the response status should be 400

  # ── Backend: Search and promote ────────────────────────────────────

  @backend
  Scenario: Search finds bans across hub and platform scope
    Given a super admin user
    And a hub ban and a platform ban exist for the same phone number
    When the admin GETs "/bans/platform/search?phone=+12125551234"
    Then the response should contain 2 ban entries

  @backend
  Scenario: Promote hub ban to platform scope
    Given a super admin user
    And a hub-scoped ban exists with id "hub-ban-001"
    When the admin POSTs to "/bans/platform/promote" with banId "hub-ban-001"
    Then the response status should be 200
    And a platform-scoped ban should exist for the same phone number

  @backend
  Scenario: Cannot promote already platform-scoped ban
    Given a super admin user
    And a platform-scoped ban exists with id "platform-ban-001"
    When the admin POSTs to "/bans/platform/promote" with banId "platform-ban-001"
    Then the response status should be 409

  # ── Backend: Permission enforcement ────────────────────────────────

  @backend
  Scenario: Hub admin cannot access platform bans
    Given a hub admin user (without platform ban permission)
    When the admin GETs "/bans/platform"
    Then the response status should be 403

  # ── Backend: Platform ban enforced during call routing ──────────────

  @backend
  Scenario: Platform-banned caller is blocked on any hub
    Given a platform ban exists for "+12125551234"
    And hub "hub-a" has no hub-specific ban for that number
    When a call arrives from "+12125551234" to hub "hub-a"
    Then the call should be rejected as banned
