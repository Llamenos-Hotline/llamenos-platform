@backend
Feature: Account Erasure
  As a user or admin
  I want to request and process account erasure
  So that user data is removed in compliance with GDPR

  # ── Backend: Self-service erasure ───────────────────────────────────

  @backend
  Scenario: Volunteer requests own account erasure
    Given a volunteer user
    When the volunteer POSTs to "/erasure/me" with a justification
    Then the response status should be 200
    And the response should contain an erasure request with status "pending"
    And the executeAt should be approximately 72 hours in the future

  # @wip: response assertion steps have no backend definitions — #1198
  @backend @wip
  Scenario: Volunteer cannot create duplicate erasure request
    Given a registered volunteer user with a pending erasure request
    When the volunteer POSTs to "/erasure/me" again
    Then the response status should be 409
    And the response should contain error "Erasure request already pending"

  # @wip: response assertion steps have no backend definitions — #1198
  @backend @wip
  Scenario: Volunteer cancels pending erasure request
    Given a registered volunteer user with a pending erasure request
    When the volunteer DELETEs "/erasure/me"
    Then the response status should be 200
    And the response should contain ok true

  @backend
  Scenario: Volunteer checks own erasure status with no pending request
    Given a registered volunteer user with no pending erasure request
    When the volunteer GETs "/erasure/me"
    Then the response status should be 200
    And the response should contain request null

  # ── Backend: Admin erasure ──────────────────────────────────────────

  @backend
  Scenario: Admin can list erasure requests
    Given an admin user
    And 2 pending erasure requests exist
    When the admin GETs "/erasure/requests"
    Then the response status should be 200
    And the response should contain a list of requests with total 2

  # @wip: response assertion steps have no backend definitions — #1198
  @backend @wip
  Scenario: Admin executes immediate erasure
    Given an admin user
    And a target volunteer user exists
    When the admin POSTs to "/erasure/:userId" with a justification
    Then the response status should be 200
    And the response should contain ok true
    And the response should contain reEncryptionJobIds

  @backend
  Scenario: Admin can view re-encryption jobs
    Given an admin user
    When the admin GETs "/erasure/re-encryption-jobs"
    Then the response status should be 200
    And the response should contain a jobs list

  @backend
  Scenario: Non-admin cannot access erasure admin endpoints
    Given a volunteer user
    When the volunteer GETs "/erasure/requests"
    Then the response status should be 403

  # ── Backend: Hub erasure config ─────────────────────────────────────

  @backend
  Scenario: Admin reads default erasure config for a hub
    Given an admin user
    When the admin GETs "/hubs/test-hub/erasure/config"
    Then the response status should be 200
    And the response should contain an erasure config for the hub with delayHours 72 and emergency override "enabled"
    And the erasure config should not have been saved yet

  @backend
  Scenario: Admin updates erasure config for a hub
    Given an admin user
    When the admin PATCHes "/hubs/test-hub/erasure/config" with delayHours 96 and emergency override "disabled"
    Then the response status should be 200
    And the response should contain an erasure config for the hub with delayHours 96 and emergency override "disabled"
    When the admin GETs "/hubs/test-hub/erasure/config"
    Then the response status should be 200
    And the response should contain an erasure config for the hub with delayHours 96 and emergency override "disabled"
    And the erasure config should record the admin as the last updater

  @backend
  Scenario: Saved hub erasure delay governs new self-erasure requests
    Given an admin user
    And a volunteer user
    When the admin PATCHes "/hubs/test-hub/erasure/config" with delayHours 120
    Then the response status should be 200
    When the volunteer POSTs to "/hubs/test-hub/erasure/me" with a justification
    Then the response status should be 200
    And the executeAt should be approximately 120 hours in the future

  @backend
  Scenario: Erasure config rejects a delay below the allowed minimum
    Given an admin user
    When the admin PATCHes "/hubs/test-hub/erasure/config" with delayHours 12
    Then the response status should be 400

  @backend
  Scenario: Non-admin cannot read hub erasure config
    Given a volunteer user
    When the volunteer GETs "/hubs/test-hub/erasure/config"
    Then the response status should be 403

  # ── Backend: Device wipe ────────────────────────────────────────────

  # @wip: response assertion steps have no backend definitions — #1198
  @backend @wip
  Scenario: Admin sends device wipe command
    Given an admin user
    And a target volunteer user with a known device pubkey
    When the admin POSTs to "/erasure/:userId/wipe-device/:devicePubkey"
    Then the response status should be 200
    And the response should contain ok true
