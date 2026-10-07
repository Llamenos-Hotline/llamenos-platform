@backend @security
Feature: Auth endpoint rate limiting
  Auth endpoints enforce strict per-client and per-pubkey rate limits
  to prevent brute force and credential stuffing attacks.
  Rate limits are always enforced, including in development mode.

  Each scenario names its own simulated client, so it floods a bucket of its
  own instead of one shared with every other scenario in every parallel worker.
  That naming is honoured only for a request carrying the dev surface's shared
  secret, and it is isolation and not an exemption: the limits below still fire
  at their production thresholds inside the named bucket. See
  tests/dev-surface-secret.ts and apps/worker/lib/route-rate-limit.ts.

  Background:
    Given rate limit counters are cleared

  # --- Login Rate Limiting ---

  @backend
  Scenario: Login endpoint rate limited after 5 requests per minute from same IP
    When a client sends 6 login requests from the same IP within 1 minute
    Then at least one response should be 429
    And the 429 response body should contain "Too many login attempts"

  # What this scenario does and does not prove.
  #
  # It proves the login limiter keys on the CLIENT and is not one global
  # bucket — the production bug the deployment runbook describes, where five
  # logins a minute would be the budget for the whole internet.
  #
  # It does not prove that two real callers are told apart, because one process
  # cannot be two callers: behind the deployed Caddy the address comes from
  # `header_up X-Forwarded-For {remote_host}` and every other forwarded-for
  # header is stripped, deliberately, so that no caller can choose its own
  # bucket (#1606). The addresses below are simulated, on a channel the harness
  # is credentialed for. Derivation of the REAL address is covered by
  # apps/worker/lib/client-ip.ts's own tests and by the Caddy template; showing
  # it end to end would need two clients on the proxy network, which is not
  # what this scenario is for.
  @backend
  Scenario: Login rate limit uses unique client buckets
    When a client sends 3 login requests from IP "10.99.1.1"
    And a client sends 3 login requests from IP "10.99.1.2"
    Then all 6 requests should succeed without 429

  # Each request names a different client, so the per-client bucket cannot be
  # the one that fires — the only remaining source of a 429 is the per-pubkey
  # counter, which is what this scenario is for.
  @backend
  Scenario: Login rate limit tracks per pubkey
    When a client sends 6 login requests with the same pubkey from different IPs
    Then at least one response should be 429

  # --- Bootstrap Rate Limiting ---

  @backend
  Scenario: Bootstrap endpoint rate limited after 3 requests per minute from same IP
    When a client sends 4 bootstrap requests from the same IP within 1 minute
    Then at least one response should be 429
    And the 429 response body should contain "Too many attempts"

  # --- WebAuthn Rate Limiting ---

  @backend
  Scenario: WebAuthn login options rate limited after 5 requests per minute
    When a client sends 6 WebAuthn login option requests from the same IP
    Then at least one response should be 429

  @backend
  Scenario: WebAuthn login verify rate limited after 5 requests per minute
    When a client sends 6 WebAuthn verify requests from the same IP
    Then at least one response should be 429
