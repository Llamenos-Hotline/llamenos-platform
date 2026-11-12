@backend @simulated-telephony @calls
Feature: A call routed by the provider's own signed webhooks
  A caller dials the hotline and the telephony provider drives the call with
  webhooks: /incoming, then /language-selected, then — for each volunteer leg the
  server asks it to dial — /user-answer and /call-status, and /queue-exit when
  the caller leaves the queue. Every on-shift volunteer who is not on a call is
  rung at once; the first to pick up gets the caller and every other leg is
  stopped; with nobody on shift the hub's fallback group is rung.

  These scenarios play the provider. The hub selects the mock provider with a
  webhook signing secret, so every webhook is signed and goes through the same
  signature check, handlers, ringing service and TelephonyAdapter calls a real
  provider's webhooks do — nothing is inserted or answered through a test-only
  route. Each assertion reads what the server did: the ring set it recorded on
  the call, the legs it asked the provider to dial and to stop, which pickup it
  bridged, and the call record and audit log that resulted (#1052).

  # Serial project (backend-bdd-simulated-telephony): the mock provider is only
  # selectable where the /api/test-* surface is enabled, and each scenario
  # reconfigures a hub's telephony provider. Each scenario gets a hub of its own.

  Background:
    Given a hub of its own whose calls arrive through signed mock-provider webhooks

  Scenario: Every on-shift volunteer is rung at once
    Given 3 volunteers are on shift
    When a caller dials the hotline and chooses a language
    Then the caller hears the greeting and waits in the queue
    And the ringing service rang exactly volunteers "1, 2 and 3" from the shift
    And the provider was asked to dial one leg to each of volunteers "1, 2 and 3"
    And the call is still ringing with nobody on it

  Scenario: The first pickup gets the caller and every other leg is stopped
    Given 3 volunteers are on shift
    When a caller dials the hotline and chooses a language
    And the provider was asked to dial one leg to each of volunteers "1, 2 and 3"
    And volunteer 2 picks up their leg
    Then volunteer 2's leg is bridged to the caller
    And the call is in progress and answered by volunteer 2
    And the provider was told to stop every leg but volunteer 2's
    And the hub audit log records volunteer 2 answering the call
    When volunteer 1 picks up their leg
    Then volunteer 1's leg is hung up
    And the call is in progress and answered by volunteer 2
    When volunteer 1's leg reports it has completed
    Then the call is in progress and answered by volunteer 2
    When volunteer 2's leg reports it has completed
    Then the call history records the call as "completed"
    And the hub audit log records the call ending

  Scenario: Two simultaneous pickups — exactly one gets the caller
    Given 2 volunteers are on shift
    When a caller dials the hotline and chooses a language
    And the provider was asked to dial one leg to each of volunteers "1 and 2"
    And volunteers 1 and 2 pick up their legs at the same time
    Then exactly one of the pickups is bridged and the other is hung up
    And the call is in progress and answered by the volunteer whose leg was bridged

  Scenario: Overlapping shifts ring the volunteers of both
    Given two overlapping shifts with different volunteers
    When a caller dials the hotline and chooses a language
    Then the ringing service rang exactly volunteers "1 and 2" from the shift
    And the provider was asked to dial one leg to each of volunteers "1 and 2"

  Scenario: A volunteer removed from the shift is not rung on the next call
    Given 2 volunteers are on shift
    When the admin removes the first volunteer from the shift
    And a caller dials the hotline and chooses a language
    Then the ringing service rang exactly volunteer "2" from the shift
    And the provider was asked to dial one leg to each of volunteer "2"

  Scenario: A volunteer already on a call is not rung
    Given 2 volunteers are on shift
    And volunteer 1 is already on a call in this hub
    When a caller dials the hotline and chooses a language
    Then the ringing service rang exactly volunteer "2" from the shift
    And the provider was asked to dial one leg to each of volunteer "2"

  Scenario: With nobody on shift the hub's fallback group is rung
    Given a volunteer who is not on shift is in the hub fallback group
    When a caller dials the hotline and chooses a language
    Then the caller hears the greeting and waits in the queue
    And the ringing service rang exactly volunteer "1" from the fallback group
    And the provider was asked to dial one leg to each of volunteer "1"

  Scenario: With nobody on shift and no fallback group nothing rings, and the provider is told to take a voicemail
    Given no shift is active and no fallback is configured
    When a caller dials the hotline and chooses a language
    Then the caller hears the greeting and waits in the queue
    And the ringing service rang nobody
    And the provider was asked to dial nothing
    When the caller's queue wait ends without an answer
    Then the provider is told to take a voicemail

  Scenario: A caller who leaves the queue for voicemail stops every leg still ringing
    Given 2 volunteers are on shift
    When a caller dials the hotline and chooses a language
    And the provider was asked to dial one leg to each of volunteers "1 and 2"
    And the caller's queue wait ends without an answer
    Then the provider is told to take a voicemail
    And the provider was told to stop every leg it dialled

  Scenario: A caller who hangs up in the queue is a missed call, and nobody can pick it up after
    Given 2 volunteers are on shift
    When a caller dials the hotline and chooses a language
    And the provider was asked to dial one leg to each of volunteers "1 and 2"
    And the caller hangs up while queued
    Then the provider was told to stop every leg it dialled
    And the call history records the call as "unanswered"
    And the hub audit log records the call as missed
    When volunteer 1 picks up their leg
    Then volunteer 1's late pickup does not get the caller
    And the call history records the call as "unanswered"

  @bans
  Scenario: A banned caller is rejected at the first webhook and nothing is recorded or rung
    Given 1 volunteers are on shift
    And "+15550142777" is on the ban list
    When "+15550142777" dials the hotline
    Then the call is rejected at the first webhook
    And no call was recorded

  @security
  Scenario: A pickup not signed with the hub's secret cannot take the call
    Given 1 volunteers are on shift
    When a caller dials the hotline and chooses a language
    And the provider was asked to dial one leg to each of volunteer "1"
    And someone without the hub's secret posts a pickup for volunteer 1's leg
    Then the forged webhook is refused with status 403
    And the call is still ringing with nobody on it
