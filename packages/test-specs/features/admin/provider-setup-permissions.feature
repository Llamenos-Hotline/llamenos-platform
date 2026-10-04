@backend
Feature: Provider Setup PBAC Permission Enforcement
  As a security-conscious admin
  I want provider setup endpoints to enforce PBAC permissions
  So that volunteers cannot access or modify provider configurations

  Scenario: Unauthenticated request to provider configure is rejected
    When I POST to configure provider "twilio" without authentication
    Then the provider setup response is 401

  Scenario: Unauthenticated request to provider status is rejected
    When I GET provider status for "twilio" without authentication
    Then the provider setup response is 401

  Scenario: Unauthenticated request to phone numbers is rejected
    When I GET phone numbers for "twilio" without authentication
    Then the provider setup response is 401

  Scenario: Admin can access provider setup under hub scope
    Given I am a provider setup admin
    And a provider setup hub exists
    When I POST to configure provider "twilio" under that hub
    Then the provider configure response is 200

  Scenario: Hub-scoped configure stores config for that hub
    Given I am a provider setup admin
    And a provider setup hub exists
    When I POST to configure provider "twilio" under that hub
    And I GET the provider status for "twilio" under that hub
    Then the provider status is "connected"

  Scenario: Configure-webhooks requires manage-providers permission
    Given I am a provider setup volunteer
    When I POST to configure webhooks for a number
    Then the provider setup response is 403

  Scenario: Create-sip-trunk requires manage-providers permission
    Given I am a provider setup volunteer
    When I POST to create a SIP trunk
    Then the provider setup response is 403

  # Writes the instance-wide provider every hub without its own falls back to (#1071).
  @global-setting
  Scenario: Admin can configure webhooks
    Given I am a provider setup admin
    And provider "twilio" is configured for tests
    When I POST to configure webhooks for number "PN123" with provider "twilio"
    Then the webhooks response is 200
    And the response contains ok=true
