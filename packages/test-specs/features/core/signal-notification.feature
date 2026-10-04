@backend @integration @signal @notifications
Feature: Signal Notification Service
  As the Signal notification sidecar
  I want to send security alerts and operational notifications via Signal
  So that volunteers and admins receive timely, reliable notifications

  # ── Contact Registration ──────────────────────────────────────────

  # @fixme: signal-notifier is genuinely unreachable from the CI/BDD host right now —
  # this is round 3 of PR #828 confirming fleet/review's finding (a): a real,
  # pre-existing infra bug, not a round-2 regression. Root cause (confirmed via
  # `docker inspect llamenos-signal-notifier-1 --format '{{json .NetworkSettings.Ports}}'`
  # → `{"3100/tcp":null}`, and a direct `curl http://localhost:3100/health` from the
  # host reproducing exit 7/connection-refused despite the container reporting
  # healthy internally): deploy/docker/docker-compose.yml attaches the
  # signal-notifier service to the `internal` network ONLY, and that network is
  # declared `internal: true`. Docker silently drops host port publishing
  # (`ports: - "3100:3100"` in docker-compose.test.yml) for a container whose only
  # network is `internal: true` — compare the `app` service, which is on both
  # `internal` and `web` and whose port 3000 publishes and is reachable fine. This
  # is exactly why the pre-round-2 vacuous-pass/skip logic never caught it: the
  # sidecar has probably never actually been reachable from a BDD test in CI.
  # Fix belongs in deploy/docker/docker-compose.yml or docker-compose.test.yml
  # (outside this PR's owned paths — needs a `web` network entry on the
  # signal-notifier service); un-@fixme once that lands and this passes in CI.
  # Tracked in #1196.
  @fixme
  Scenario: Register Signal contact for notifications
    Given the admin is authenticated
    When the admin registers a Signal contact with number "+15550001111"
    Then the contact should be stored in the notification service
    And the contact registration should succeed

  # ── Security Alert Delivery ───────────────────────────────────────

  # @fixme: requires POST /api/notify to actually deliver via signal-cli, which
  # requires a real registered Signal account. Neither CI nor local dev provisions
  # one (SIGNAL_REGISTERED_NUMBER is a placeholder +1555... value) — signal-cli-rest-api
  # returns 400 "Specified account does not exist" for /v2/send in that state. This is
  # a pre-existing gap (not caused by the @signal-unreachable-resilience fix that added
  # this tag), unmasked because the step definitions no longer vacuously pass when the
  # sidecar rejects the request. Needs either a provisioned test Signal number or a
  # delivery mock in signal-notifier before this can run in CI.
  # Tracked in #1196.
  @fixme
  Scenario: Security alert sent on new login IP
    Given a volunteer has a registered Signal notification contact
    When a new login from IP "203.0.113.42" is detected for the volunteer
    Then a security alert notification should be dispatched
    And the notification should contain the login IP

  # ── Delivery Reliability ──────────────────────────────────────────

  # @fixme: signal-notifier's POST /api/notify is a single synchronous call with no
  # persisted retry queue and no GET /notify/:id endpoint (see signal-notifier/src/routes.ts)
  # — this scenario tests a retry-tracking feature that does not exist in the current
  # implementation. Needs either retry tracking added to signal-notifier or this
  # scenario rewritten to match the sidecar's actual synchronous contract.
  # Tracked in #1196.
  @fixme
  Scenario: Notification delivery with retry on failure
    Given a registered Signal notification contact
    When the first delivery attempt fails
    Then the notification should be retried
    And the retry count should increment

  # ── Contact Management ────────────────────────────────────────────

  # @fixme: same signal-notifier host-unreachability infra bug as "Register Signal
  # contact for notifications" above — see that scenario's comment for the full
  # root-cause writeup (docker-compose `internal: true` network with no `web`
  # network attached silently drops the 3100 host port publish).
  # Tracked in #1196.
  @fixme
  Scenario: Unregister Signal contact stops notifications
    Given a volunteer has a registered Signal notification contact
    When the contact is unregistered
    Then subsequent notifications should not be dispatched to that contact

  # ── Security Preferences ──────────────────────────────────────────

  # @fixme: signal-notifier has no preference model of its own (preference filtering,
  # if it exists, is app-level). The real alert model (apps/worker/services/
  # user-notifications.ts AlertInput) has no generic "security event" case and no
  # "login_only"/"all" preference — this scenario's semantics don't map onto the
  # actual implementation. Needs rewriting once the real alert-type filtering design
  # (alertOnNewDevice / alertOnPasskeyChange / alertOnPinChange) is reflected here.
  # Tracked in #1196.
  @fixme
  Scenario: Security preferences control which alerts are sent
    Given a volunteer has security notification preferences set to "login_only"
    When a non-login security event occurs
    Then no notification should be dispatched for that event

  # Tracked in #1196.
  @fixme
  Scenario: All-alerts preference sends notification for every security event
    Given a volunteer has security notification preferences set to "all"
    When any security event occurs
    Then a notification should be dispatched

  # ── Health Check ──────────────────────────────────────────────────

  # @fixme: same signal-notifier host-unreachability infra bug as "Register Signal
  # contact for notifications" above — see that scenario's comment for the full
  # root-cause writeup (docker-compose `internal: true` network with no `web`
  # network attached silently drops the 3100 host port publish).
  # Tracked in #1196.
  @fixme
  Scenario: Signal notification service health check returns healthy
    When the signal-notifier health endpoint is requested
    Then the notifier response status should be 200
