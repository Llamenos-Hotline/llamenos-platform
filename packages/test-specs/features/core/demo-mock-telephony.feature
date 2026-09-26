Feature: Demo mock telephony
  A demo or staging instance has no PSTN number, so an admin selects the mock telephony
  provider for a hub and simulates an incoming call. The simulated call travels the real
  routing path (ban check, shift and ring-group resolution, call:ring) and is then answered,
  noted and ended through the ordinary calls and notes endpoints.

  # These scenarios need a server started with DEMO_MODE=true and DEMO_MODE_CONFIRM set,
  # so they run in their own project (backend-bdd-demo-mode) and never in the default one.
  # The production refusal is covered by apps/worker/__tests__/unit/mock-telephony.test.ts,
  # because a live server cannot be flipped into ENVIRONMENT=production.

  # Unlike relay-event-delivery.feature (which uses the /test-simulate shortcut), this drives the
  # production ringing path — startParallelRinging — so a ring published without its hub fails here.
  @backend @demo-mode @calls @relay
  Scenario: A simulated call rings on the hub it arrived on and on no other hub
    Given 1 volunteers are on shift
    And the hub uses the mock telephony provider
    And the test relay is connected and capturing events
    And a volunteer who is a member of a different hub only
    When the admin simulates an incoming call
    Then the relay should receive a kind 1000 event within 5 seconds
    And the decrypted event content type should be "call:ring"
    And the event hubId should be the scenario hub
    And that volunteer's relay subscription to the scenario hub should be refused

  @backend @demo-mode @calls
  Scenario: Simulated call rings, is answered, noted and ended
    Given 2 volunteers are on shift
    And the hub uses the mock telephony provider
    When the admin simulates an incoming call
    Then the response status should be 200
    And the simulated call should have notified 2 volunteers
    And the call status should be "ringing"
    When volunteer 0 answers the simulated call
    Then the call status should be "in-progress"
    And the hub audit log should contain a "callAnswered" entry
    When volunteer 0 creates a note for the active call
    Then a note should exist linked to that call ID
    And the hub audit log should contain a "noteCreated" entry
    When volunteer 0 hangs up the simulated call
    Then the call status should be "completed"

  @backend @demo-mode @calls
  Scenario: The simulated caller can hang up before anyone answers
    Given 1 volunteers are on shift
    And the hub uses the mock telephony provider
    When the admin simulates an incoming call
    And the simulated caller hangs up
    Then the response status should be 200
    And the call status should be "unanswered"

  @backend @demo-mode @calls @bans
  Scenario: A banned caller is rejected before anything rings
    Given 1 volunteers are on shift
    And the hub uses the mock telephony provider
    And "+15550142001" is on the ban list
    When the admin simulates an incoming call from "+15550142001"
    Then the response status should be 403

  @backend @demo-mode @calls
  Scenario: Nothing rings when no volunteer is on shift
    Given the hub uses the mock telephony provider
    When the admin simulates an incoming call
    Then the response status should be 422

  # The ring outcome (volunteersNotified) is server state: the count of volunteers the ringing
  # service actually selected, not anything the test remembers. See #1055.
  @backend @demo-mode @calls
  Scenario: The fallback group rings when everyone on shift is on break
    Given 1 volunteers are on shift
    And every on-shift volunteer is on break
    And a volunteer who is not on shift is in the hub fallback group
    And the hub uses the mock telephony provider
    When the admin simulates an incoming call
    Then the response status should be 200
    And the simulated call should have notified 1 volunteers
    And the call status should be "ringing"

  @backend @demo-mode @calls
  Scenario: Nothing rings when everyone on shift and in the fallback group is on break
    Given 1 volunteers are on shift
    And every on-shift volunteer is on break
    And a volunteer who is not on shift is in the hub fallback group
    And the fallback volunteer is on break
    And the hub uses the mock telephony provider
    When the admin simulates an incoming call
    Then the response status should be 422

  # #1017: out-of-shift calls ring the CALLED hub's own fallback group. volunteersNotified is
  # the count the real ringing service selected, so these fail if the wrong group is read or
  # if a user with no access to the hub is rung.
  @backend @demo-mode @calls
  Scenario: The hub's own fallback group rings when no one is on shift
    Given a volunteer who is not on shift is in the hub fallback group
    And the hub uses the mock telephony provider
    When the admin simulates an incoming call
    Then the response status should be 200
    And the simulated call should have notified 1 volunteers

  @backend @demo-mode @calls
  Scenario: The instance-wide fallback group is never rung for a hub's call
    Given a volunteer is in the instance-wide fallback group
    And the hub uses the mock telephony provider
    When the admin simulates an incoming call
    Then the response status should be 422

  @backend @demo-mode @calls
  Scenario: A fallback volunteer who belongs only to another hub is not rung
    Given a volunteer who is not on shift is in the hub fallback group
    And a volunteer who belongs only to another hub is also in the hub fallback group
    And the hub uses the mock telephony provider
    When the admin simulates an incoming call
    Then the response status should be 200
    And the simulated call should have notified 1 volunteers

  @backend @demo-mode @calls
  Scenario: A hub that has not selected the mock cannot be simulated against
    Given 1 volunteers are on shift
    When the admin simulates an incoming call
    Then the response status should be 409

  @backend @demo-mode @calls
  Scenario: Only an admin can simulate a call
    Given 1 volunteers are on shift
    And the hub uses the mock telephony provider
    When volunteer 0 tries to simulate an incoming call
    Then the response status should be 403

  @backend @demo-mode @calls @audit
  Scenario: Simulating a call is audit-logged
    Given 1 volunteers are on shift
    And the hub uses the mock telephony provider
    When the admin simulates an incoming call
    Then the audit log should record the simulated call
