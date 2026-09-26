@backend @security
Feature: Backend access control and input validation (Epic E)
  Surgical fixes for seven backend security vulnerabilities identified in the
  2026-05-18 security audit: co-approver admin check (H01), cross-hub IDOR on
  records/by-contact, account-lockdown re-auth, blast input sanitization (H02),
  SSRF fail-closed on DNS failure (H07), and PUK envelope race condition (H09).

  # ── H01: Co-approver must be a registered admin device ────────────────────

  @backend
  Scenario: Erasure co-approver with volunteer role is rejected
    Given a registered volunteer user with pubkey "vol-pk-1"
    And a registered admin user with pubkey "admin-pk-1"
    When "vol-pk-1" submits an emergency erasure request
    And the co-approver signature is made by "vol-pk-1" (a volunteer, not an admin)
    Then the response status is 403
    And the error mentions co-approver must be an admin

  @backend
  Scenario: Erasure co-approver with hub-admin role is accepted
    Given a registered admin user with pubkey "admin-pk-1" and role "role-hub-admin"
    And a registered volunteer user with pubkey "vol-pk-2"
    When "vol-pk-2" submits an emergency erasure request
    And the co-approver signature is made by "admin-pk-1" (a hub admin)
    Then the response status is 201

  @backend
  Scenario: Erasure co-approver with unknown pubkey is rejected
    Given no user is registered with pubkey "unknown-pk-1"
    When a volunteer submits an emergency erasure request
    And the co-approver signature is made by "unknown-pk-1"
    Then the response status is 403
    And the error mentions co-approver must be a registered admin device

  # ── IDOR: Hub isolation on /records/by-contact ────────────────────────────

  @backend
  Scenario: Records by contact are scoped to the caller's hub
    Given hub "hub-alpha" has a case record for contact "C-001"
    And hub "hub-beta" also has a case record for contact "C-001"
    And I am authenticated as a volunteer in "hub-alpha"
    When I call GET /api/records/by-contact/C-001
    Then the response status is 200
    And the returned records all belong to hub "hub-alpha"
    And no records from hub "hub-beta" are returned

  @backend
  Scenario: Records by contact returns empty list for contact not in caller hub
    Given hub "hub-alpha" has no records for contact "C-002"
    And hub "hub-beta" has a case record for contact "C-002"
    And I am authenticated as a volunteer in "hub-alpha"
    When I call GET /api/records/by-contact/C-002
    Then the response status is 200
    And the returned records list is empty

  # ── HIGH-W4: Non-admin volunteer only sees own records via /by-contact ────

  @backend
  Scenario: Non-admin volunteer only sees their own records via by-contact (HIGH-W4)
    Given hub "hub-alpha" has two case records for contact "C-003"
    And record "R-001" is created by volunteer "vol-pk-1"
    And record "R-002" is created by volunteer "vol-pk-2"
    And I am authenticated as volunteer "vol-pk-1" in "hub-alpha" with "cases:read-own"
    When I call GET /api/records/by-contact/C-003
    Then the response status is 200
    And the returned records contain only "R-001"
    And record "R-002" is not visible

  @backend
  Scenario: Admin sees all records via by-contact regardless of ownership
    Given hub "hub-alpha" has two case records for contact "C-003"
    And record "R-001" is created by volunteer "vol-pk-1"
    And record "R-002" is created by volunteer "vol-pk-2"
    And I am authenticated as admin in "hub-alpha" with "cases:read-all"
    When I call GET /api/records/by-contact/C-003
    Then the response status is 200
    And the returned records contain both "R-001" and "R-002"

  # ── Lockdown: Account lockdown requires Schnorr re-auth ───────────────────

  @backend
  Scenario: Account lockdown via session token is rejected
    Given I am authenticated with a session token (not a Schnorr-signed request)
    When I call POST /api/account/lockdown
    Then the response status is 401
    And the error code is "ELEVATED_AUTH_REQUIRED"

  @backend
  Scenario: Account lockdown via Schnorr-signed request is accepted
    Given I am authenticated with a fresh Schnorr-signed Ed25519 request
    When I call POST /api/account/lockdown
    Then the response status is 200

  @backend
  Scenario: Account lockdown/complete via session token is rejected (HIGH-W5)
    Given I am authenticated with a session token (not a Schnorr-signed request)
    When I call POST /api/account/lockdown/complete with valid completion payload
    Then the response status is 401
    And the error code is "ELEVATED_AUTH_REQUIRED"

  @backend
  Scenario: Account lockdown/complete via Schnorr-signed request is accepted
    Given I am authenticated with a fresh Schnorr-signed Ed25519 request
    When I call POST /api/account/lockdown/complete with valid completion payload
    Then the response status is 200

  # ── H02: Blast content sanitization ──────────────────────────────────────

  @backend
  Scenario: Blast with null byte in body is rejected
    Given I am authenticated as an admin
    When I call POST /api/blasts with body containing a null byte character
    Then the response status is 400
    And the error mentions control characters

  @backend
  Scenario: Blast with BEL control character in body is rejected
    Given I am authenticated as an admin
    When I call POST /api/blasts with body "hello\x07world"
    Then the response status is 400
    And the error mentions control characters

  @backend
  Scenario: Blast with backspace control character in body is rejected
    Given I am authenticated as an admin
    When I call POST /api/blasts with body containing ASCII backspace (0x08)
    Then the response status is 400
    And the error mentions control characters

  @backend
  Scenario: Blast with newline characters in body is accepted
    Given I am authenticated as an admin
    When I call POST /api/blasts with body "Line 1\nLine 2"
    Then the response status is not 400

  @backend
  Scenario: Blast with tab characters in body is accepted
    Given I am authenticated as an admin
    When I call POST /api/blasts with body "Column A\tColumn B"
    Then the response status is not 400

  # ── H07: SSRF guard fails closed on DNS resolution failure ────────────────

  @backend
  Scenario: Webhook URL with unresolvable hostname is blocked
    Given an external provider URL "https://nonexistent.example.invalid/webhook"
    And DNS resolution for "nonexistent.example.invalid" fails with NXDOMAIN
    When the SSRF guard validates the URL
    Then the URL is blocked
    And the error message mentions DNS

  @backend
  Scenario: Webhook URL resolving to public IP is allowed
    Given an external provider URL "https://api.example.com/webhook"
    And DNS resolution for "api.example.com" returns "93.184.216.34"
    When the SSRF guard validates the URL
    Then the URL is allowed

  @backend
  Scenario: Webhook URL resolving to private IP is blocked even if hostname looks public
    Given an external provider URL "https://evil.example.com/webhook"
    And DNS resolution for "evil.example.com" returns "192.168.1.1"
    When the SSRF guard validates the URL
    Then the URL is blocked
    And the error message mentions internal address

  # ── H09: PUK envelope concurrent write idempotency ───────────────────────

  @backend
  Scenario: Concurrent PUK envelope distribution for same generation both succeed
    Given I am authenticated as a volunteer with two active devices
    When two simultaneous POST /api/puk/envelopes requests are sent for generation 3 on device "dev-1"
    Then both responses have status 201
    And exactly one envelope record exists for (device "dev-1", generation 3)

  @backend
  Scenario: PUK envelope upsert overwrites stale envelope for same generation
    Given device "dev-1" has a PUK envelope for generation 2
    When I call POST /api/puk/envelopes with a new envelope for generation 2 on device "dev-1"
    Then the response status is 201
    And the stored envelope for (device "dev-1", generation 2) is updated to the new value

  @backend
  Scenario: PUK envelope retrieval returns the latest generation
    Given device "dev-1" has PUK envelopes for generations 1, 2, and 3
    When I call GET /api/puk/envelopes/dev-1
    Then the response status is 200
    And the returned generation is 3

  # ── HIGH-W2: Dev endpoint checkResetSecret only accepts X-Test-Secret ────

  @backend
  Scenario: Dev test-reset rejects requests without X-Test-Secret header
    Given the server is running in development mode with DEV_RESET_SECRET set
    When I call POST /api/dev/test-reset without X-Test-Secret header
    Then the response status is 404

  @backend
  Scenario: Dev test-reset rejects requests with wrong X-Test-Secret
    Given the server is running in development mode with DEV_RESET_SECRET set
    When I call POST /api/dev/test-reset with X-Test-Secret "wrong-secret"
    Then the response status is 404

  @backend
  Scenario: Dev test-reset accepts requests with correct X-Test-Secret
    Given the server is running in development mode with DEV_RESET_SECRET set
    When I call POST /api/dev/test-reset with correct X-Test-Secret
    Then the response status is 200

  @backend
  Scenario: Dev test-reset returns 404 in production environment
    Given the server is running in production mode
    When I call POST /api/dev/test-reset with any credentials
    Then the response status is 404

  # ── HIGH-W3: Ban list does not store plaintext phone numbers ─────────────

  @backend
  Scenario: Banning a phone stores only a masked display value (HIGH-W3)
    Given I am authenticated as an admin with "bans:create" permission
    When I ban the phone number "+12125551234" with reason "Spam"
    Then the ban response contains phone "***1234"
    And the stored phoneDisplay field does not contain the full phone number

  @backend
  Scenario: Bulk ban stores only masked display values (HIGH-W3)
    Given I am authenticated as an admin with "bans:bulk-create" permission
    When I bulk ban phones ["+12125551234", "+12125555678"]
    Then the stored phoneDisplay values are "***1234" and "***5678"

  # ── HIGH-W6: Recovery group emergency override requires matching pubkey ──

  @backend
  Scenario: Emergency override rejects mismatched approverPubkey (HIGH-W6)
    Given I am authenticated as an admin with "recovery:approve" permission
    And my pubkey is "admin-pk-1"
    And a recovery session exists and is awaiting contributions
    When I call POST /api/recovery-group/session/{id}/emergency with approverPubkey "other-pk-2"
    Then the response status is 403
    And the error mentions approverPubkey must match

  @backend
  Scenario: Emergency override accepts matching approverPubkey (HIGH-W6)
    Given I am authenticated as an admin with "recovery:approve" permission
    And my pubkey is "admin-pk-1"
    And a recovery session exists and is awaiting contributions
    When I call POST /api/recovery-group/session/{id}/emergency with approverPubkey "admin-pk-1"
    Then the response is not 403
