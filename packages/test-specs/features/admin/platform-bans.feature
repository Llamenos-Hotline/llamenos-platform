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
    When the admin GETs "/admin/bans"
    Then the response status should be 200
    And the response should contain an empty bans list

  @backend
  Scenario: Super admin creates a platform ban
    Given a super admin user
    When the admin POSTs to "/admin/bans" with phone "+12125551234" and reason "Repeat offender"
    Then the response status should be 200
    And the response should contain ok true

  @backend
  Scenario: Created platform ban appears in list
    Given a super admin user
    And a platform ban exists for "+12125551234"
    When the admin GETs "/admin/bans"
    Then the response should contain 1 ban

  @backend
  Scenario: Super admin removes a platform ban
    Given a super admin user
    And a platform ban exists with id "ban-001"
    When the admin DELETEs "/admin/bans/ban-001"
    Then the response status should be 200
    And the response should contain ok true

  @backend
  Scenario: Delete returns 404 for unknown ban
    Given a super admin user
    When the admin DELETEs "/admin/bans/nonexistent-id"
    Then the response status should be 404

  # ── Backend: Bulk import ────────────────────────────────────────────

  @backend
  Scenario: Super admin bulk imports platform bans
    Given a super admin user
    When the admin POSTs to "/admin/bans/bulk" with 3 phone numbers
    Then the response status should be 200
    And the response should contain count 3

  @backend
  Scenario: Bulk import rejects an entry that is not a ban digest
    Given a super admin user
    When the admin POSTs to "/admin/bans/bulk" with an entry that is not a ban digest
    Then the response status should be 400

  # ── Backend: The server never receives the number (#2759) ───────────
  # Every client sends ban digests: it blinds the number, the server evaluates the
  # blinded element under the scope's key (RFC 9497 OPRF), and the client finalizes.

  @backend
  Scenario: Creating a platform ban refuses a plaintext phone number
    Given a super admin user
    When the admin POSTs a plaintext phone number "+12125551234" to "/admin/bans"
    Then the response status should be 400

  @backend
  Scenario: Bulk import refuses plaintext phone numbers
    Given a super admin user
    When the admin POSTs a plaintext phone number "+12125551234" to "/admin/bans/bulk"
    Then the response status should be 400

  @backend
  Scenario: Ban evaluation refuses a malformed blinded element
    Given a super admin user
    When the admin asks "/admin/bans/evaluate" to evaluate an element that is not a group element
    Then the response status should be 400

  @backend
  Scenario: Search evaluation refuses a malformed blinded element
    Given a super admin user
    When the admin asks "/admin/bans/search/evaluate" to evaluate an element that is not a group element
    Then the response status should be 400

  @backend
  Scenario: A hub admin cannot use the platform ban key as an oracle
    Given a hub admin user (without platform ban permission)
    When the hub admin asks "/admin/bans/evaluate" to evaluate a blinded number
    Then the response status should be 403

  @backend
  Scenario: A hub admin cannot evaluate numbers for a platform search
    Given a hub admin user (without platform ban permission)
    When the hub admin asks "/admin/bans/search/evaluate" to evaluate a blinded number
    Then the response status should be 403

  # ── Backend: Search and promote ────────────────────────────────────

  @backend
  Scenario: Search finds bans across hub and platform scope
    Given a super admin user
    And a hub ban and a platform ban exist for the same phone number
    When the admin searches all bans for "+12125551234"
    Then the response should contain 2 ban entries

  @backend
  Scenario: Promote hub ban to platform scope
    Given a super admin user
    And a hub-scoped ban exists with id "hub-ban-001"
    When the admin POSTs to "/admin/bans/promote" with banId "hub-ban-001"
    Then the response status should be 200
    And a platform-scoped ban should exist for the same phone number

  @backend
  Scenario: Promoting a hub ban requires the number to be entered again
    Given a super admin user
    And a hub-scoped ban exists with id "hub-ban-002"
    When the admin POSTs to "/admin/bans/promote" with banId "hub-ban-002" and no phone number
    Then the response status should be 400

  @backend
  Scenario: Promoting a hub ban with a different number is refused
    Given a super admin user
    And a hub-scoped ban exists with id "hub-ban-003"
    When the admin POSTs to "/admin/bans/promote" with banId "hub-ban-003" and a different phone number
    Then the response status should be 400

  @backend
  Scenario: Cannot promote already platform-scoped ban
    Given a super admin user
    And a platform-scoped ban exists with id "platform-ban-001"
    When the admin POSTs to "/admin/bans/promote" with banId "platform-ban-001"
    Then the response status should be 409

  # ── Backend: Permission enforcement ────────────────────────────────

  @backend
  Scenario: Hub admin cannot access platform bans
    Given a hub admin user (without platform ban permission)
    When the admin GETs "/admin/bans"
    Then the response status should be 403

  # ── Backend: Platform ban enforced during call routing ──────────────

  # The ban was created from a client-side digest; the call is matched by the server's own
  # digest of the caller's number. This passing is the proof the two are the same function.
  @backend
  Scenario: Platform-banned caller is blocked on any hub
    Given a platform ban exists for "+12125551234"
    And hub "hub-a" has no hub-specific ban for that number
    When a call arrives from "+12125551234" to hub "hub-a"
    Then the call should be rejected as banned
