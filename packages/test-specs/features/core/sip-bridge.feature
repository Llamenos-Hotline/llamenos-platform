@backend @telephony @sip
Feature: SIP Bridge HTTP Surface
  As the SIP bridge service
  I want to expose its own health and status over signed HTTP
  So that operators and the Worker can observe its PBX connection and call state

  # The 27 scenarios originally planned for this file (#1192) described a call-flow
  # protocol — ring / bridge / gather / queue / recording commands, a `/command`
  # endpoint, and PBX client selection — that does not match sip-bridge's real HTTP
  # surface (sip-bridge/src/index.ts has no `/command` route; there is no HTTP
  # endpoint the Worker calls to "send a bridge command"). Commands the Worker
  # issues arrive as the JSON response body to a webhook sip-bridge already sent
  # (see BridgeCommand / WORKER_PATHS / CALLBACK_PATHS in sip-bridge/src/types.ts),
  # and PBX client selection is a constructor choice with no HTTP surface at all.
  # None of that is an API-level backend-bdd scenario. It is already covered,
  # better, at the level it actually lives at:
  #   - sip-bridge/src/command-handler.test.ts — every call-flow state transition
  #     (ring, cancel-ringing, bridge, Tier 5 SFrame passthrough/no-record, gather,
  #     queue hold/leave, recording lifecycle + TTL sweep, channel hangup cleanup)
  #     against a mocked PBX client.
  #   - sip-bridge/src/client-factory.test.ts — PBX_TYPE → AriClient/EslClient/
  #     KamailioClient selection, including the aliasing guard.
  #   - sip-bridge/src/clients/kamailio-client.test.ts — the Kamailio JSONRPC
  #     client, including dispatcher list/set-state management.
  #   - sip-bridge/src/clients/ari-client.test.ts — the ARI WebSocket client.
  #   - deploy/docker/tests/telephony/asterisk-bridge-contract.test.ts — the real
  #     Worker AsteriskAdapter wired to the real sip-bridge CommandHandler through
  #     a fake worker, across a full call (menu, captcha, queue, ring, bridge,
  #     recording, voicemail timeout).
  #   - deploy/docker/tests/telephony/asterisk-call.e2e.ts — a real SIP call
  #     through a real self-hosted Asterisk, including real recording retrieval.
  #   - packages/test-specs/features/core/sip-bridge-integration.feature — the
  #     Worker-facing call lifecycle (ringing, answer, DTMF, recording, voicemail)
  #     via the Worker's own API.
  #
  # What genuinely is backend-bdd-shaped — a real running sip-bridge's own HTTP
  # endpoints, observed as a black box the way the Worker observes them — had no
  # coverage anywhere (not even a unit test for sip-bridge/src/index.ts). The three
  # scenarios below close that gap for real, against the live sip-bridge sidecar
  # (docker compose --profile telephony; CI starts it via bootstrap-backend).

  Scenario: Bridge health check reports PBX connection state
    Given a running sip-bridge with PBX_TYPE "asterisk"
    When I GET /health
    Then the response status should be 200
    And the response body should contain "pbxType"
    And the response body should contain "connected"

  Scenario: Authenticated status endpoint reports channel and bridge counts
    Given a running sip-bridge with PBX_TYPE "asterisk"
    When I GET /status with a valid X-Bridge-Signature
    Then the response status should be 200
    And the response body should contain "channels"
    And the response body should contain "bridges"

  Scenario: Status endpoint rejects an unsigned request
    Given a running sip-bridge with PBX_TYPE "asterisk"
    When I GET /status without a signature
    Then the response status should be 403
