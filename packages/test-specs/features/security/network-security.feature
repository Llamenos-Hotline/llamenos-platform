@ios @android @security
Feature: Network Security
  As a security-conscious app
  I want all network connections and relay URLs to be validated
  So that traffic cannot be intercepted and SSRF attacks are prevented

  # ── HTTPS Enforcement ─────────────────────────────────────────────

  @desktop
  Scenario: HTTP hub URL is rejected during setup
    Given I am on the setup or identity creation screen
    When I enter hub URL "http://insecure.example.org"
    And I submit the form
    Then I should see an error about insecure connection
    And the connection should not be established

  @desktop
  Scenario: HTTPS hub URL is accepted
    Given I am on the setup or identity creation screen
    When I enter hub URL "https://hub.llamenos.org"
    And I submit the form
    Then I should not see a connection security error

  # ── Relay URL Validation ──────────────────────────────────────────

  @requires-camera
  Scenario: QR code with localhost relay shows error
    Given I am authenticated
    And I navigate to the device link screen from settings
    When a QR code with relay URL "wss://localhost:4869" is scanned
    Then I should see the error state
    And the error message should mention private or local network

  @requires-camera
  Scenario: QR code with private IP 192.168.x.x relay shows error
    Given I am authenticated
    And I navigate to the device link screen from settings
    When a QR code with relay URL "wss://192.168.1.100:4869" is scanned
    Then I should see the error state
    And the error message should mention private or local network

  @requires-camera
  Scenario: QR code with private IP 10.x.x.x relay shows error
    Given I am authenticated
    And I navigate to the device link screen from settings
    When a QR code with relay URL "wss://10.0.0.1:4869" is scanned
    Then I should see the error state
    And the error message should mention private or local network

  @requires-camera
  Scenario: QR code with loopback IPv6 relay shows error
    Given I am authenticated
    And I navigate to the device link screen from settings
    When a QR code with relay URL "wss://[::1]:4869" is scanned
    Then I should see the error state
    And the error message should mention private or local network

  @requires-camera
  Scenario: QR code with link-local relay shows error
    Given I am authenticated
    And I navigate to the device link screen from settings
    When a QR code with relay URL "wss://169.254.1.1:4869" is scanned
    Then I should see the error state
    And the error message should mention private or local network

  @requires-camera
  Scenario: QR code with valid public relay proceeds
    Given I am authenticated
    And I navigate to the device link screen from settings
    When a QR code with relay URL "wss://relay.llamenos.org" is scanned
    Then I should not see a relay URL error
    And the step should advance to "Verify"

  # ── SAS Verification Gate ─────────────────────────────────────────

  @desktop
  Scenario: Device linking shows SAS code on verify step
    Given I am authenticated
    And I navigate to the device link screen from settings
    And a valid provisioning room is established
    When the ephemeral key exchange completes
    Then I should see a 6-digit SAS code displayed
    And I should see instructions to compare with the other device
    And I should see "Confirm" and "Reject" buttons

  @desktop
  Scenario: SAS confirmation required before device key import
    Given I am authenticated
    And I navigate to the device link screen from settings
    And a valid provisioning room is established
    And the ephemeral key exchange completes
    And an encrypted device key is received from the other device
    When I have not yet confirmed the SAS code
    Then the device key should not be imported
    And the crypto service should not have a new key

  @desktop
  Scenario: SAS confirmation allows device key import
    Given I am authenticated
    And I navigate to the device link screen from settings
    And a valid provisioning room is established
    And the ephemeral key exchange completes
    And an encrypted device key is received from the other device
    When I confirm the SAS code matches
    Then the device key should be imported
    And I should see the import success state

  @desktop
  Scenario: SAS rejection aborts device linking
    Given I am authenticated
    And I navigate to the device link screen from settings
    And a valid provisioning room is established
    And the ephemeral key exchange completes
    When I reject the SAS code
    Then the provisioning room should be closed
    And I should see a "Linking cancelled" message
    And the device key should not be imported

  # ── Backend: Security Audit Coverage ──────────────────────────────

  @backend
  Scenario: Vonage webhook rejects missing HMAC signature
    Given a Vonage webhook request without a signature parameter
    When the webhook validation runs
    Then the request should be rejected

  @backend
  Scenario: Vonage webhook rejects expired timestamp
    Given a Vonage webhook request with a timestamp older than 5 minutes
    When the webhook validation runs
    Then the request should be rejected as replay

  @backend
  Scenario: Volunteer self-update rejects role escalation fields
    Given a volunteer PATCH request with "roles" set to admin
    When the update is processed
    Then the "roles" field should be stripped from the update

  @backend
  Scenario: Security headers are present on all API responses
    When a client makes any API request
    Then the response should include COOP, Referrer-Policy, and X-Content-Type-Options headers

  @backend
  Scenario: Login endpoint verifies Schnorr signature
    Given a login request with a valid pubkey but no Schnorr signature
    When the login is processed
    Then the server should reject the request

  @backend
  Scenario: CAPTCHA digits are not exposed in URL parameters
    Given a CAPTCHA challenge is generated
    Then the expected digits should not appear in any URL or response body
    And the digits should be stored server-side only

  @backend
  Scenario: Invite redemption requires proof of private key
    Given an invite code exists
    When someone tries to redeem it without a Schnorr signature
    Then the redemption should fail with 400

  @backend
  Scenario: Upload chunk endpoint enforces ownership
    Given volunteer A uploads a file chunk
    When volunteer B tries to access volunteer A's upload status
    Then the request should be rejected with 403

  @backend
  Scenario: Sessions are revoked on volunteer deactivation
    Given a volunteer with an active session
    When the volunteer is deactivated by an admin
    Then the volunteer's session tokens should be invalidated

  @backend
  Scenario: Reporter role cannot create call notes
    Given a user with reporter role
    When they attempt to create a call note
    Then the server should reject with 403

  @backend
  Scenario: Dev reset requires DEV_RESET_SECRET when configured
    Given the DEV_RESET_SECRET environment variable is set
    When a reset request is made without the X-Test-Secret header
    Then the reset should be rejected

  @backend
  Scenario: SSRF blocklist rejects IPv4-mapped IPv6 private addresses
    Given a provider test URL of "http://[::ffff:127.0.0.1]/api"
    When the SSRF guard evaluates the URL
    Then it should be blocked as an internal address

  @backend
  Scenario: Phone hashing uses HMAC-SHA256, not bare SHA-256
    Given a phone number "+15551234567"
    When it is hashed with two different HMAC secrets
    Then the hashes should be different

  @backend
  Scenario: Admin pubkey not exposed in public config
    When the public /api/config endpoint is queried
    Then the response should not contain adminPubkey

  @backend
  Scenario: Invite creation blocks privilege escalation
    Given a volunteer-permissioned user
    When they try to create an invite with admin role
    Then the server should reject with 403 citing missing permissions

  @backend
  Scenario: WebSocket relay events are encrypted
    Given a hub with SERVER_SECRET configured
    When the server publishes a WebSocket event
    Then the event content should be encrypted with the derived event key

  @backend
  Scenario: Auth tokens without method+path binding are rejected
    Given a Schnorr token signed without method and path
    When it is presented to an API endpoint
    Then the server should reject with 401

  @backend
  Scenario: Contact identifiers are encrypted at rest
    Given a new conversation with phone "+15551234567"
    When the conversation is stored
    Then the stored phone value should start with "enc:"

  @backend
  Scenario: BlastDO subscriber hashing uses HMAC_SECRET
    Given HMAC_SECRET is set to a unique value
    When a subscriber phone is hashed for the blast list
    Then the hash should depend on HMAC_SECRET, not a public constant

  @backend
  Scenario: serverEventKeyHex is not in public config
    When the unauthenticated /api/config endpoint is queried
    Then the response should not contain serverEventKeyHex

  @backend
  Scenario: serverEventKeyHex is available after authentication
    Given an authenticated user
    When they query /api/auth/me
    Then the response should contain serverEventKeyHex

  @backend
  Scenario: DEMO_MODE=false prevents DO reset in production
    Given DEMO_MODE is set to "false"
    When a reset request is sent to any Durable Object
    Then the reset should be rejected

  @backend
  Scenario: Hub slug must match pattern
    When creating a hub with slug "-invalid-slug-"
    Then the server should reject with a validation error

  @backend
  Scenario: Blast mediaUrl must use HTTPS
    When creating a blast with mediaUrl "http://cdn.example.com/image.jpg"
    Then the server should reject with a validation error about HTTPS

  @backend
  Scenario: Upload size is capped at 10MB
    When uploading a file of 11MB
    Then the server should reject with 413 Payload Too Large

  # ── Certificate Pinning ───────────────────────────────────────────

  # Mobile-only: these assert a static, pre-configured wildcard pin list
  # ("*.llamenos.org"), which is the iOS/Android pinning model
  # (apps/android network_security_config.xml + OkHttp CertificatePinner).
  # Desktop's model is fundamentally different — TOFU per-origin SPKI
  # capture, no wildcard support (apps/desktop/src/cert_pin.rs) — so a
  # desktop step bound to this wording would assert a configuration desktop
  # doesn't have. Desktop's own pinning behavior is covered by Rust unit
  # tests in cert_pin.rs, not BDD. These were only ever tagged for desktop
  # because the feature-level @desktop tag used to leak onto them with no
  # desktop steps to match — #1195. They remain @wip pending real
  # android/ios step definitions, which is outside desktop's scope.
  @android @ios @security @wip
  Scenario: App refuses connection to server with mismatched certificate
    Given the app is configured with certificate pins for "*.llamenos.org"
    When the app connects to a server presenting a certificate not matching any pin
    Then the connection should be refused
    And no data should be transmitted

  # @wip: same mobile-only wildcard pinning model as above — desktop uses
  # TOFU per-origin SPKI capture instead; see cert_pin.rs — #1195
  @android @ios @security @wip
  Scenario: App succeeds when server certificate matches a configured pin
    Given the app is configured with certificate pins for "*.llamenos.org"
    When the app connects to a server presenting a certificate matching a pin
    Then the connection should succeed
