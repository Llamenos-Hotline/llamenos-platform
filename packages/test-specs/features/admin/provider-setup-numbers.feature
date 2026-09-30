@backend
Feature: Provider Setup Phone Number Management
  As an admin
  I want to manage phone numbers through the provider setup API
  So that I can provision and configure numbers without manual provider console access

  # Writes the instance-wide provider every hub without its own falls back to (#1071).
  @global-setting
  Scenario: Admin lists owned phone numbers
    Given I am a provider setup admin
    And provider "twilio" is configured for tests
    When I GET phone numbers for provider "twilio"
    Then the phone numbers response is 200
    And the response contains a numbers array

  # Writes the instance-wide provider every hub without its own falls back to (#1071).
  @global-setting
  Scenario: Admin searches available numbers
    Given I am a provider setup admin
    And provider "twilio" is configured for tests
    When I POST to search phone numbers with providerType "twilio" and countryCode "US"
    Then the phone numbers search response is 200
    And the response contains a numbers array

  # Writes the instance-wide provider every hub without its own falls back to (#1071).
  @global-setting
  Scenario: Phone number search is rate limited to 5 per minute
    Given I am a provider setup admin
    And provider "twilio" is configured for tests
    When I POST to search phone numbers 6 times in quick succession
    Then at least one search response is 429

  Scenario: Non-admin cannot list owned numbers
    Given I am a provider setup volunteer
    When I GET phone numbers for provider "twilio"
    Then the phone numbers response is 403

  Scenario: Non-admin cannot search available numbers
    Given I am a provider setup volunteer
    When I POST to search phone numbers with providerType "twilio" and countryCode "US"
    Then the phone numbers search response is 403

  Scenario: List numbers requires provider query parameter
    Given I am a provider setup admin
    When I GET phone numbers without a provider param
    Then the phone numbers response is 400
