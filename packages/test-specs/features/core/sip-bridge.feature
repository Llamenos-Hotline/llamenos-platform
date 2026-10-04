# @wip: no backend step definitions for any scenario — #1192
@backend @wip
Feature: SIP Bridge Integration
  As the SIP bridge service
  I want to translate PBX events into Worker webhooks and execute commands
  So that calls are routed through self-hosted PBX backends (Asterisk, FreeSWITCH, Kamailio)

  # ── Health Check ────────────────────────────────────────────────

  Scenario: Bridge health check returns PBX status
    Given a running sip-bridge with PBX_TYPE "asterisk"
    When I GET /health
    Then the response status should be 200
    And the response body should contain "pbxType"
    And the response body should contain "connected"

  Scenario: Bridge status endpoint returns channel and bridge counts
    Given a running sip-bridge with PBX_TYPE "asterisk"
    When I GET /status
    Then the response status should be 200
    And the response body should contain "channels"
    And the response body should contain "bridges"

  # ── Incoming Call Flow ──────────────────────────────────────────

  Scenario: Incoming call triggers Worker webhook with JSON payload
    Given a running sip-bridge connected to Asterisk
    When a channel_create event arrives with callerNumber "+15551234567"
    Then the bridge should POST to "/api/telephony/incoming"
    And the payload should contain channelId and callerNumber
    And the payload content-type should be "application/json"

  Scenario: Incoming SFrame call sets mode to sframe
    Given a running sip-bridge connected to Asterisk
    When a channel_create event arrives with args ["sframe"]
    Then the call should be tracked with mode "sframe"
    And recording should be banned for this call

  Scenario: Incoming PSTN call sets mode to pstn
    Given a running sip-bridge connected to Asterisk
    When a channel_create event arrives with args []
    Then the call should be tracked with mode "pstn"
    And recording should be allowed for this call

  # ── Parallel Ring ───────────────────────────────────────────────

  Scenario: Ring command originates calls to volunteers
    Given a running sip-bridge with an active incoming call "ch-caller"
    When the Worker sends a ring command for 3 volunteers
    Then 3 outbound channels should be originated
    And each channel should have appArgs containing "dialed"

  Scenario: Volunteer answers and other ringing channels are cancelled
    Given 3 volunteer channels ringing for parent call "ch-caller"
    When volunteer channel "ch-vol-1" answers (channel_create with args ["dialed", "ch-caller", "pubkey1"])
    Then a webhook should be sent to "/api/telephony/volunteer-answer"
    And the other 2 ringing channels should be hung up

  # ── Bridge Command ──────────────────────────────────────────────

  Scenario: Bridge command connects caller and volunteer
    Given caller "ch-caller" in queue and volunteer "ch-vol" answered
    When the Worker sends a bridge command
    Then a bridge should be created connecting both channels
    And hold music should be stopped on the caller channel

  Scenario: SFrame call bridge uses passthrough mode
    Given an SFrame-mode call "ch-caller" and volunteer "ch-vol"
    When the Worker sends a bridge command with bridgeType "passthrough"
    Then the bridge should be created with passthrough (no media termination)

  Scenario: SFrame call recording is blocked (Tier 5 guard)
    Given an SFrame-mode call "ch-caller" bridged to "ch-vol"
    When the Worker sends a bridge command with record=true
    Then recording should be skipped
    And a warning should be logged about Tier 5 SFrame

  # ── DTMF Gather ────────────────────────────────────────────────

  Scenario: Gather collects DTMF digits and sends callback
    Given an active call "ch-1" with a gather waiting for 4 digits
    When DTMF digits "1234" are received
    Then a webhook should be sent with digits "1234"
    And the gather prompt should be stopped

  Scenario: Gather timeout sends empty digits
    Given an active call "ch-1" with a gather (timeout 5s, 4 digits)
    When the gather times out without digits
    Then a webhook should be sent with empty digits

  # ── Queue ───────────────────────────────────────────────────────

  Scenario: Queue command starts hold music and periodic callbacks
    Given an active call "ch-1"
    When the Worker sends a queue command with waitCallbackPath
    Then hold music should start on the channel
    And periodic wait callbacks should fire at the configured interval

  Scenario: Queue leave triggers voicemail flow
    Given caller "ch-1" in queue with exitCallbackPath
    When the queue wait callback returns a leave_queue redirect
    Then a queue-exit webhook should be sent with result "leave"

  # ── Recording ───────────────────────────────────────────────────

  Scenario: Recording complete event triggers callback webhook
    Given a recording "call-ch1-12345" with a registered callback
    When a recording_complete event arrives
    Then a webhook should be sent to the callback path
    And the recording callback should be removed

  Scenario: Stale recording callbacks are pruned by TTL sweep
    Given a recording callback registered 6 minutes ago
    When the TTL sweep runs
    Then the stale callback should be removed

  # ── Channel Hangup ─────────────────────────────────────────────

  Scenario: Channel hangup cleans up all call state
    Given an active call "ch-1" with gather, queue, ringing channels, and bridge
    When a channel_hangup event arrives for "ch-1"
    Then the gather timeout should be cleared
    And the queue interval should be cleared
    And the bridge should be destroyed
    And ringing channels should be hung up
    And the call should be removed from tracking

  Scenario: Volunteer hangup sends call-status webhook
    Given volunteer channel "ch-vol" ringing for parent "ch-caller"
    When channel "ch-vol" hangs up with cause 17 (busy)
    Then a call-status webhook should be sent with status "busy"

  # ── HTTP Command Endpoint ──────────────────────────────────────

  Scenario: POST /command requires valid HMAC signature
    Given a running sip-bridge
    When I POST /command with an invalid X-Bridge-Signature
    Then the response status should be 403

  Scenario: POST /command with valid signature executes action
    Given a running sip-bridge with valid HMAC credentials
    When I POST /command with action "status"
    Then the response status should be 200
    And the response body should contain "activeCalls"

  # ── Recording Audio Retrieval ──────────────────────────────────

  Scenario: GET /recordings/:name returns audio with valid signature
    Given a recording "voicemail-ch1-12345" stored in the PBX
    When I GET /recordings/voicemail-ch1-12345 with valid signature
    Then the response status should be 200
    And the content-type should be "audio/wav"

  Scenario: GET /recordings/:name rejects invalid signature
    Given a running sip-bridge
    When I GET /recordings/test with an invalid signature
    Then the response status should be 403

  # ── Client Factory ─────────────────────────────────────────────

  Scenario: PBX_TYPE=asterisk creates ARI client
    Given PBX_TYPE is set to "asterisk"
    When the client factory creates a bridge client
    Then the client should be an ARI WebSocket client

  Scenario: PBX_TYPE=freeswitch creates ESL client
    Given PBX_TYPE is set to "freeswitch"
    When the client factory creates a bridge client
    Then the client should be an ESL TCP client

  Scenario: PBX_TYPE=kamailio creates JSONRPC client
    Given PBX_TYPE is set to "kamailio"
    When the client factory creates a bridge client
    Then the client should be a Kamailio JSONRPC client
    And all call-control methods should throw

  # ── Kamailio Dispatcher Management ─────────────────────────────

  Scenario: Kamailio client lists dispatcher entries
    Given a Kamailio JSONRPC endpoint at "http://kamailio:5060/jsonrpc"
    When I request the dispatcher list for set ID 1
    Then I should receive a list of backend URIs with flags and priorities

  Scenario: Kamailio client sets dispatcher state
    Given a Kamailio JSONRPC endpoint
    When I set dispatcher "sip:10.0.0.1:5060" to state "inactive"
    Then the JSONRPC call should use method "dispatcher.set_state"
    And the state code should be 1 (inactive)
