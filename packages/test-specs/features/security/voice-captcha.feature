@backend @signed-webhooks
Feature: Voice CAPTCHA and the over-limit action — every refusal is visible to the people responsible
  A caller gets two attempts at the voice CAPTCHA and can press star to hear
  the digits again; a caller who fails or times out is offered voicemail, never
  silently dropped. A number calling more often than the hub allows gets the
  hub's over-limit action — by default a short unrecorded message, then the
  call ends. The operator accepted that only on condition that the hub's
  responsible people see it happening, so every refusal opens a spam incident
  for the members holding the spam permission: counts only, never the caller.

  These scenarios post real Twilio-signed webhooks (#2179, #2345).

  Background:
    Given an isolated hub for incident scenarios
    And a hub member whose role grants only "settings:manage-spam"
    And a hub member whose role grants only "telephony:manage-providers"
    And a hub volunteer with no incident permission
    And the server accepts Twilio-signed calls for the incident hub

  @backend
  Scenario: The 11th call in a minute hears the rate-limited message, and the spam holder sees it happening
    Given the incident hub allows 10 calls a minute from one number
    When 11 calls from one number reach the incident hub within one minute
    Then the first 10 calls are put through to the queue
    And the last call hears the rate-limited message and is hung up with nothing recorded
    And the "settings:manage-spam" holder sees one open "spam" incident counting 1 "over_limit_message"
    And the "telephony:manage-providers" holder sees no incidents
    And the volunteer sees no incidents
    And the open spam incident holds nothing that identifies the caller

  @backend
  Scenario: A hub that chose voicemail for over-limit callers keeps that choice when another spam setting changes
    Given the incident hub allows 1 calls a minute from one number
    And the incident hub's over-limit action is "voicemail"
    When the incident hub's voice CAPTCHA is switched off
    Then the incident hub's over-limit action is still "voicemail"
    When 2 calls from one number reach the incident hub within one minute
    Then the last call is offered voicemail
    And the "settings:manage-spam" holder sees one open "spam" incident counting 1 "over_limit_voicemail"

  @backend
  Scenario: A wrong first answer gets a second attempt with the same digits, and the right one is queued
    Given the incident hub has the voice CAPTCHA on
    When a caller reaches the incident hub and is challenged
    And the caller enters the wrong digits
    Then the caller hears the retry prompt and the same digits again
    When the caller enters the right digits
    Then the caller is queued for a volunteer
    And the volunteer sees no incidents

  @backend
  Scenario: Star replays the digits without spending an attempt
    Given the incident hub has the voice CAPTCHA on
    When a caller reaches the incident hub and is challenged
    And the caller presses star
    Then the caller hears the same digits again without the retry prompt
    When the caller enters the wrong digits
    Then the caller hears the retry prompt and the same digits again

  @backend
  Scenario: No input twice is a timeout: the caller is offered voicemail and the spam holder sees it
    Given the incident hub has the voice CAPTCHA on
    When a caller reaches the incident hub and is challenged
    And the caller enters nothing
    Then the caller hears the retry prompt and the same digits again
    When the caller enters nothing
    Then the caller is offered voicemail
    And the "settings:manage-spam" holder sees one open "spam" incident counting 1 "timeout"
    And the open spam incident holds nothing that identifies the caller

  @backend
  Scenario: Two wrong answers fail the CAPTCHA: the caller is offered voicemail and the spam holder sees it
    Given the incident hub has the voice CAPTCHA on
    When a caller reaches the incident hub and is challenged
    And the caller enters the wrong digits
    And the caller enters the wrong digits
    Then the caller is offered voicemail
    And the "settings:manage-spam" holder sees one open "spam" incident counting 1 "fail"
    And the volunteer sees no incidents
