@backend
Feature: Provider Setup Direct Configuration
  As an admin
  I want to configure telephony providers with direct credentials
  So that I can manage provider connections without OAuth

  # Writes the instance-wide provider every hub without its own falls back to (#1071).
  @global-setting
  Scenario: Admin configures a provider with valid credentials
    Given I am a provider setup admin
    When I POST to configure provider "twilio" with credentials
    Then the provider configure response is 200
    And the response contains ok=true

  Scenario: Provider status returns disconnected for unconfigured provider
    Given I am a provider setup admin
    When I GET the provider status for "vonage"
    Then the provider status response is 200
    And the provider status is "disconnected"

  # Writes the instance-wide provider every hub without its own falls back to (#1071).
  @global-setting
  Scenario: Admin can test a stored connection
    Given I am a provider setup admin
    And provider "twilio" is configured for tests
    When I POST to test connection for provider "twilio"
    Then the provider test response is 200
    And the test result has a connected field
    And the test result has a latencyMs field

  Scenario: Non-admin cannot configure a provider
    Given I am a provider setup volunteer
    When I POST to configure provider "twilio" with credentials
    Then the provider configure response is 403

  # Writes the instance-wide provider every hub without its own falls back to (#1071).
  @global-setting
  Scenario: Volunteer with view permission can read provider status
    Given I am a volunteer with telephony:view-providers permission
    And provider "twilio" is configured for tests
    When I GET the provider status for "twilio"
    Then the provider status response is 200

  # Writes the instance-wide provider every hub without its own falls back to (#1071).
  @global-setting
  Scenario: Credentials are never returned in any response
    Given I am a provider setup admin
    And provider "twilio" is configured for tests
    When I GET the provider status for "twilio"
    Then the provider status response is 200
    And the response does not contain credentials
