# @wip: needs rate-limit buckets isolated from the parallel suite — #1194
@backend @security @wip
Feature: Persistent rate limiting
  Rate limit state persists in PostgreSQL and survives server restarts.
  Different endpoint tiers have different limits.

  Background:
    Given a clean test environment
    And rate limit counters are cleared

  # --- C03: Persistent Rate Limiter ---

  @backend
  Scenario: Auth endpoint rate limited after 5 requests per minute
    When I make 6 authentication requests to "/api/auth/me" within 1 minute from the same IP
    Then the 6th request should return 429
    And the Retry-After header should be present

  @backend
  Scenario: 429 response includes Retry-After header with positive integer
    When I make 6 authentication requests to "/api/auth/me" within 1 minute from the same IP
    Then the 6th response status should be 429
    And the Retry-After header should contain a positive integer

  # --- H03: Rate Limit Coverage ---

  @backend
  Scenario: Write endpoints reject after 30 requests per minute
    Given I am authenticated
    When I make 31 POST requests to a write endpoint within 1 minute
    Then the 31st request should return 429

  @backend
  Scenario: Read endpoints reject after 120 requests per minute
    Given I am authenticated
    When I make 121 GET requests to a read endpoint within 1 minute
    Then the 121st request should return 429

  @backend
  Scenario: Webhook endpoints allow 300 requests per minute
    Given a telephony provider is configured
    When 300 valid webhook requests arrive within 1 minute
    Then all 300 should succeed
    And the 301st should return 429

  @backend
  Scenario: Health endpoints are not rate limited
    When I make 500 requests to "/api/health/ready"
    Then all responses should be 200

  @backend
  Scenario: Different tiers have independent counters
    Given I am authenticated
    When I make 5 POST requests to "/api/auth/me" within 1 minute
    And I make 5 GET requests to "/api/users" within 1 minute
    Then both sets of requests should succeed
