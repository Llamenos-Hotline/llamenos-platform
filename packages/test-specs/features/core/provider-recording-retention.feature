Feature: Caller audio does not stay at the telephony provider
  A voicemail is recorded by the hub's telephony provider, on the provider's disk, outside
  the E2EE boundary. The hotline fetches it and then deletes it AT THE PROVIDER (#2297, the
  #1505 posture: "fetched and then deleted at the provider, or never created"). Every
  recording the provider still holds is tracked server-side until the provider confirms it
  is gone, so a deletion the provider refused is visible to the hub's admins and is never
  mistaken for one that happened.

  # These drive the real voicemail processing path through the MockTelephonyAdapter, so
  # they run in the serial backend-bdd-simulated-telephony project (see
  # simulated-telephony.feature for why that project exists). The mock refuses to delete
  # any recording whose id starts with "mock-undeletable-", standing in for a provider
  # that refuses or cannot be reached.

  @backend @simulated-telephony @calls
  Scenario: A voicemail recording is deleted at the provider once it has been fetched
    Given 1 volunteers are on shift
    And the hub uses the mock telephony provider
    When the admin simulates an incoming call
    And the simulated caller leaves a voicemail the provider holds as "mock-rec-vm-1"
    Then the response status should be 200
    And the provider should have confirmed deleting the voicemail recording
    And the hub's recording posture should show 0 recordings still held at the provider
    And the hub call history should contain 1 call with a voicemail

  @backend @simulated-telephony @calls @audit
  Scenario: A provider that refuses the deletion is reported, never treated as deleted
    Given 1 volunteers are on shift
    And the hub uses the mock telephony provider
    When the admin simulates an incoming call
    And the simulated caller leaves a voicemail the provider holds as "mock-undeletable-vm-2"
    Then the response status should be 200
    And the provider deletion of the voicemail recording should be reported as failed
    And the hub's recording posture should show 1 recording still held at the provider
    And the recording still held at the provider should carry the provider's refusal
    And the hub audit log should contain a "providerRecordingDeleteFailed" entry

  @backend @simulated-telephony @calls
  Scenario: The recording posture says what it read, not what it assumes
    Given the hub uses the mock telephony provider
    When the admin reads the hub's recording posture
    Then the response status should be 200
    And the posture should report provider-side recording as "off" with the evidence it read
    And the posture should report provider-side transcription as "off" with the evidence it read

  @backend @simulated-telephony @calls @permissions
  Scenario: Only a telephony manager can read the recording posture
    Given 1 volunteers are on shift
    And the hub uses the mock telephony provider
    When volunteer 0 reads the hub's recording posture
    Then the response status should be 403
