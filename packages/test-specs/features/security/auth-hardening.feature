# @wip: needs per-scenario server env (ENVIRONMENT, DEV_AUTH_BYPASS) — #1194
@backend @security @wip
Feature: Auth bypass removal and dev route gating
  Dev-mode shortcuts for auth bypass, dev route access, and webhook
  signature verification are removed or gated behind explicit flags.

  # --- C01: Dev Auth Bypass ---

  @backend
  Scenario: Dev-mode does not bypass signature verification by default
    Given the environment is "development"
    And DEV_AUTH_BYPASS is not set
    And a registered user with a valid pubkey
    When I send a request with a valid pubkey but invalid signature
    Then the response status should be 401

  @backend
  Scenario: DEV_AUTH_BYPASS enables bypass when explicitly set
    Given the environment is "development"
    And DEV_AUTH_BYPASS is "true"
    And a registered user with a valid pubkey
    When I send a request with a valid pubkey but invalid signature
    Then the response status should be 200

  @backend
  Scenario: DEV_AUTH_BYPASS has no effect in production
    Given the environment is "production"
    And DEV_AUTH_BYPASS is "true"
    And a registered user with a valid pubkey
    When I send a request with a valid pubkey but invalid signature
    Then the response status should be 401

  @backend
  Scenario: Valid signature accepted in development mode
    Given the environment is "development"
    And DEV_AUTH_BYPASS is not set
    And a registered user with a valid keypair
    When I send a request with a valid pubkey and valid Ed25519 signature
    Then the response status should be 200

  # --- H04: Dev Routes Gating ---

  @backend
  Scenario: Dev routes unavailable when DEV_ROUTES_ENABLED is unset
    Given the environment is "development"
    And DEV_ROUTES_ENABLED is not set
    When I POST to "/api/test-reset" with valid X-Test-Secret
    Then the response status should be 404

  @backend
  Scenario: Dev routes unavailable in production
    Given the environment is "production"
    And DEV_ROUTES_ENABLED is "true"
    When I POST to "/api/test-reset" with valid X-Test-Secret
    Then the response status should be 404

  @backend
  Scenario: Bearer token alone does not grant dev route access
    Given the environment is "development"
    And DEV_ROUTES_ENABLED is "true"
    When I POST to "/api/test-reset" with only an Authorization Bearer token
    Then the response status should be 404

  @backend
  Scenario: X-Test-Secret grants dev access when DEV_ROUTES_ENABLED
    Given the environment is "development"
    And DEV_ROUTES_ENABLED is "true"
    When I POST to "/api/test-reset" with valid X-Test-Secret
    Then the response status should be 200

  # --- H05: Webhook Signature Enforcement ---

  @backend
  Scenario: Localhost webhook without valid signature is rejected
    Given the environment is "development"
    And a telephony provider is configured
    When I POST to "/api/telephony/incoming" from 127.0.0.1 without a valid signature
    Then the response status should be 403

  @backend
  Scenario: Webhook with valid provider signature is accepted
    Given a telephony provider is configured with test credentials
    When I POST to "/api/telephony/incoming" with a valid provider signature
    Then the response status should be 200
