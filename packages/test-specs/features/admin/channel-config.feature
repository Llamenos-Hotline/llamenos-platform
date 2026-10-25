@backend
Feature: Channel Configuration
  As a hub admin
  I want to configure messaging channels
  So that my hotline can receive and send messages via multiple channels

  Background:
    Given I am authenticated as a hub admin
    And I have the "settings:manage-messaging" permission

  Scenario: Enable SMS channel
    When I PATCH "/settings/messaging" with:
      | field           | value |
      | sms.enabled     | true  |
    Then the channel config response status is 200
    And the response "enabledChannels" includes "sms"

  Scenario: Set SMS content mode to notification-only
    When I PATCH "/settings/messaging" with:
      | field          | value             |
      | smsContentMode | notification-only |
    Then the channel config response status is 200
    And the response "smsContentMode" is "notification-only"

  Scenario: Configure WhatsApp with Twilio integration mode
    When I PATCH "/settings/messaging" with:
      | field                      | value  |
      | whatsapp.integrationMode   | twilio |
      | whatsapp.autoResponse      | Hi!    |
    Then the channel config response status is 200
    And the response "whatsapp.integrationMode" is "twilio"

  Scenario: Configure WhatsApp with direct Meta API mode
    When I PATCH "/settings/messaging" with:
      | field                       | value        |
      | whatsapp.integrationMode    | direct       |
      | whatsapp.phoneNumberId      | 1234567890   |
      | whatsapp.businessAccountId  | 9876543210   |
    Then the channel config response status is 200
    And the response "whatsapp.integrationMode" is "direct"

  Scenario: Configure Telegram bot
    When I PATCH "/settings/messaging" with:
      | field                  | value                       |
      | telegram.enabled       | true                        |
      | telegram.botToken      | 123456:ABC-DEF              |
      | telegram.botUsername   | @TestBot                    |
      | telegram.webhookSecret | tg-webhook-secret           |
    Then the channel config response status is 200
    And the response "telegram.botToken" is "123456:ABC-DEF"

  Scenario: A Telegram bot without a webhook secret is refused at configure time
    When I PATCH "/settings/messaging" with:
      | field                  | value                       |
      | telegram.enabled       | true                        |
      | telegram.botToken      | 123456:ABC-DEF              |
    Then the channel config response status is 400

  Scenario: An RCS agent without a webhook secret is refused at configure time
    When I PATCH "/settings/messaging" with:
      | field                  | value                       |
      | rcs.agentId            | agent-1                     |
      | rcs.serviceAccountKey  | {}                          |
      | rcs.fallbackToSms      | false                       |
    Then the channel config response status is 400

  Scenario: Test messaging channel connection
    Given the "signal" channel is configured
    When I POST "/settings/messaging/test" with:
      | field   | value  |
      | channel | signal |
    Then the channel config response status is 200
    And the response has a "connected" boolean field

  Scenario: Set auto-response messages
    When I PATCH "/settings/messaging" with:
      | field                        | value                           |
      | sms.autoResponse             | Thanks for contacting us        |
      | sms.afterHoursResponse       | We are currently closed         |
    Then the channel config response status is 200

  Scenario: Get A2P registration status
    When I GET "/provider-setup/a2p/status"
    Then the channel config response status is 200 or 404

  Scenario: Skip A2P registration
    Given I have the "telephony:manage-a2p" permission
    When I POST "/provider-setup/a2p/skip" with:
      | field | value |
    Then the channel config response status is 200
    And the response "brandStatus" is "skipped"

  Scenario: Unauthorized user cannot configure channels
    Given I am authenticated as a regular volunteer
    And I do not have the "settings:manage-messaging" permission
    When I PATCH "/settings/messaging" with:
      | field       | value |
      | sms.enabled | true  |
    Then the channel config response status is 403
