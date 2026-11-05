@backend
Feature: Webhook replay protection
  Webhooks from telephony and messaging providers must not be replayable.
  Replayed webhooks return idempotent 200 OK to support provider retries.

  Scenario: Webhook with wrong Content-Type is rejected
    Given a configured telephony provider expecting form-encoded content
    And a webhook with Content-Type "application/json"
    When the webhook is delivered
    Then the response status should be 403

  Scenario: Webhook from non-allowlisted IP is rejected
    Given IP allowlisting is enabled for provider "TWILIO"
    And the request comes from IP "1.2.3.4"
    When the webhook is delivered
    Then the response status should be 403

  # Regression for #1036: webhookAuth and validateWebhook both inserted the same
  # replay nonce, so every genuine, correctly-signed webhook was swallowed as a
  # "replay" with a text/plain 200 "OK" before its handler ran. Only a real
  # provider-signed request through the whole middleware stack can catch that.
  #
  # Needs a server started with TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
  # TWILIO_PHONE_NUMBER (the env-var provider fallback) whose values are also
  # exported to the test process, so the test can sign like Twilio does. That is
  # instance-wide config, so these run in the opt-in `backend-bdd-signed-webhooks`
  # project (`BDD_SIGNED_WEBHOOKS=true bun run test:backend:bdd`) and fail loudly,
  # never skip, when the environment is missing.
  @signed-webhooks
  Scenario: First delivery of a correctly signed webhook reaches its handler and returns TwiML
    Given the server accepts Twilio-signed telephony webhooks
    When a Twilio-signed incoming-call webhook is delivered
    Then the webhook response should be TwiML and not the replay acknowledgement

  @signed-webhooks
  Scenario: Replayed delivery of a signed webhook is acknowledged without re-running the handler
    Given the server accepts Twilio-signed telephony webhooks
    When a Twilio-signed incoming-call webhook is delivered twice
    Then the first webhook response should be TwiML
    And the second webhook response should be the plain replay acknowledgement

  @signed-webhooks
  Scenario: A webhook with a bad signature is rejected and does not consume the replay nonce
    Given the server accepts Twilio-signed telephony webhooks
    When an unsigned incoming-call webhook is delivered
    And a Twilio-signed incoming-call webhook with the same payload is delivered
    Then the unsigned webhook response status should be 403
    And the webhook response should be TwiML and not the replay acknowledgement

  # #2460: a call belongs to the hub that owns the number it was placed to. A
  # correctly signed call to a number no active hub owns used to proceed in a
  # pseudo-hub nobody administers. It is refused unanswered, and the refusal is
  # visible as a platform-scope incident — it has no hub to be raised in.
  @signed-webhooks
  Scenario: A signed call to a number no hub owns is refused, and the refusal is visible
    Given the server accepts Twilio-signed telephony webhooks
    When a Twilio-signed incoming call to a number no hub owns is delivered
    Then the webhook response should reject the call
    And the platform should have an open routing incident for an unrouted number
