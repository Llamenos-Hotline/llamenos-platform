@backend
Feature: Signal Messaging Channel
  As the Signal messaging subsystem
  I want to handle receipts, reactions, registration, retry, identity trust, and failover
  So that Signal communications are reliable and secure

  # ── Receipt & Reaction Handling ──────────────────────────────────

  # messages.external_id is a globally-unique column (it's the provider's message
  # ID in production), so these two scenarios — and
  # core/signal-integration.feature's "Signal delivery receipt updates message
  # status" scenario, which independently uses "1700000000000" — must each use a
  # distinct literal; a shared one collides under this suite's parallel execution.

  Scenario: Delivery receipt updates message status
    Given an outbound message was sent via Signal with timestamp "1700000002000"
    When a delivery receipt webhook arrives for timestamp "1700000002000"
    Then the message status should be updated to "delivered"

  Scenario: Read receipt updates message status
    Given an outbound message was sent via Signal with timestamp "1700000002001"
    When a read receipt webhook arrives for timestamp "1700000002001"
    Then the message status should be updated to "read"

  Scenario: Emoji reaction is broadcast via Nostr
    Given an active Signal conversation
    When a reaction webhook arrives with emoji "thumbsup" targeting timestamp "1700000000000"
    Then a MESSAGE_REACTION WebSocket event should be published
    And the event should contain the emoji and target timestamp

  Scenario: Typing indicator is broadcast as ephemeral event
    Given an active Signal conversation
    When a typing STARTED webhook arrives from the contact
    Then a TYPING_INDICATOR WebSocket event should be published
    And the event should indicate typing is active

  Scenario: Unknown envelope types are acknowledged without error
    Given the Signal webhook is configured
    When an envelope with no dataMessage, receiptMessage, or typingMessage arrives
    Then the webhook should return 200 OK

  # ── Registration & Provisioning ──────────────────────────────────
  # No CI/local environment has a registered Signal number (see the @fixme on
  # core/signal-integration.feature's "Unrecognised envelope type" scenario,
  # tracked in #1196), so these scenarios bind to the DB-backed registration
  # state machine in apps/worker/services/provider-setup/signal-registration.ts
  # (routes: /provider-setup/signal/*) rather than the legacy bridge-synchronous
  # flow in apps/worker/routes/setup.ts. That state machine's statuses are
  # idle|pending|verifying|complete|failed — not pending_verification/verified —
  # so this feature asserts the real status strings instead of the ones a live
  # bridge round-trip would produce.

  Scenario: Admin initiates Signal number registration
    Given the admin is authenticated
    And a Signal bridge is reachable at the configured URL
    When the admin submits a phone number for registration
    Then the registration state should be "pending"
    And an audit log entry should be created

  Scenario: Admin verifies registration code
    Given registration is pending for "+15551234567"
    When the admin submits verification code "123456"
    Then the registration state should be "complete"
    And an audit log entry should be created

  Scenario: Registration fails with captcha requirement
    Given the Signal bridge requires a captcha
    When the admin attempts to register without a captcha
    Then the registration should fail with a captcha error message

  Scenario: Admin retrieves account information
    Given Signal is configured with a registered number
    When the admin requests account info
    Then the response should indicate registered status
    And include the Signal UUID

  # ── Retry Queue & Rate Limiting ──────────────────────────────────

  Scenario: Failed message is enqueued for retry
    Given a Signal message fails to send due to bridge timeout
    When the message is enqueued
    Then it should have status "pending" with retry count 0

  Scenario: Retry uses exponential backoff
    Given a queued message has failed 2 times
    When the message fails again
    Then the next retry delay should be approximately 120 seconds

  Scenario: Message moves to dead-letter after max retries
    # "queued message status" (not "message status") to stay distinct from the
    # conversation-message status checker already bound for the receipt
    # scenarios above — the retry queue and the conversation message log are
    # different tables with independent status fields.
    Given a queued message has been retried 5 times
    When it fails again
    Then the queued message status should be "dead"
    And it should appear in the dead-letter queue

  Scenario: Rate limit prevents rapid sends to same recipient
    Given 3 messages were sent to "+15559876543" in the last minute
    When another message is attempted to the same number
    Then the send should be rate-limited

  Scenario: Admin can retry dead-letter messages
    Given a dead-letter message exists
    When the admin retries the message
    Then it should have status "pending" with retry count 0

  # ── Identity Trust Management ────────────────────────────────────

  Scenario: New contact identity is recorded as TRUSTED_UNVERIFIED
    Given a message arrives from a new Signal UUID
    When the identity is recorded
    Then the trust level should be "TRUSTED_UNVERIFIED"

  Scenario: Identity key change resets trust to UNTRUSTED
    Given a known contact with trust level "TRUSTED_VERIFIED"
    When their identity key fingerprint changes
    Then their trust level should be "UNTRUSTED"
    And the key change counter should increment

  Scenario: Admin can set identity trust level
    Given an untrusted Signal identity
    When the admin sets trust level to "TRUSTED_UNVERIFIED"
    Then the identity trust should be updated
    And an audit log entry should be created

  Scenario: Verified identities include verifier info
    Given an admin verifies a Signal identity
    Then the identity record should include the admin's pubkey
    And a verification timestamp

  # ── Number Failover ──────────────────────────────────────────────
  # apps/worker/messaging/signal/failover.ts is real, tested, pure state-machine
  # code with no HTTP route and no caller from the send path yet (tracked
  # separately — wiring it in needs a `failover` field on the shared
  # SignalConfig type, which is packages/shared/ and outside backend's owned
  # paths). These scenarios drive the real exported functions directly via
  # dev-only test endpoints; "a health check runs" uses an injectable health
  # checker (also added to failover.ts) instead of a real bridge, since no
  # reachable bridge exists in CI/local either.

  Scenario: Primary bridge failure triggers failover to backup
    Given failover is enabled with threshold 3
    And the primary bridge has failed 3 consecutive health checks
    When a health check runs
    Then the active target should switch to "backup"

  Scenario: Primary recovery triggers automatic switch-back
    Given the active target is "backup" with auto-recover enabled
    When the primary bridge health check succeeds
    Then the active target should switch back to "primary"

  Scenario: Manual failover override by admin
    Given the active target is "primary"
    When the admin manually sets the target to "backup"
    Then the active target should be "backup"
    And the failover timestamp should be recorded

  Scenario: Messages route to active bridge config
    Given failover is active with backup target
    When a message is sent via Signal
    Then it should use the backup bridge URL and credentials
