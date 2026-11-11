@backend @global-setting @setup-completion
Feature: First-run setup completion
  The setup wizard's terminal act is POST /api/setup/complete: it founds the
  default hub when none exists and flips the deployment-wide setupCompleted
  flag that /api/config serves to pre-login clients deciding between the
  wizard and the login screen. A defect here breaks the very first thing a
  new deployment does — and until #1698 no scenario touched this route, which
  is how #1488 landed into it with every gate green.

  The route's contract (apps/worker/routes/setup.ts), which these scenarios
  hold it to:

    - admin-only (settings:manage-setup) — anonymous callers get 401, a
      volunteer without the permission gets 403, and a refused call changes
      nothing
    - validated — a body that is not a real IANA timezone is refused with 400
      and setupCompleted is not written
    - idempotent — completing an already-complete setup succeeds and founds
      NO second default hub

  Tagged global-setting because setupCompleted is one server-wide flag, so these run in the
  serial project (playwright.config.ts), never alongside the parallel suite.

  Every scenario starts from a genuine first-run state: the Given resets the
  deployment's setup state to what a fresh install holds and the After hook puts
  the original back, so the "flag flips" assertions can actually fail. (The
  suite's bootstrap completes setup before any scenario runs, so without the
  reset "setupCompleted is true afterwards" would hold with the route deleted.)

  What this file cannot reach: the default-hub FOUNDING branch itself and its
  all-or-nothing behaviour (#1150). It runs only when the instance holds zero
  hubs, and a shared backend running scenarios in parallel never does. That
  branch is held by apps/worker/__tests__/unit/routes/setup.test.ts; what is
  asserted here is the other half — that re-completion never founds a second hub.

  Scenario: First-run setup completes and the public config stops presenting the wizard
    Given the deployment is in its first-run state
    Then the public config reports setup not completed
    When the admin reads the setup state
    Then the response status should be 200
    And the setup state body reports setup not completed
    When the admin saves wizard progress at step "telephony"
    Then the response status should be 200
    When the admin reads the setup state
    Then the response status should be 200
    And the setup state body shows wizard step "telephony"
    And the public config reports setup not completed
    When the admin completes setup
    Then the response status should be 200
    And the completion body reports setupCompleted true
    And the public config reports setup completed

  Scenario: Completing setup again succeeds and founds no additional default hub
    Given the deployment is in its first-run state
    When the admin completes setup
    Then the response status should be 200
    When the admin notes the founded default hubs
    And the admin completes setup
    Then the response status should be 200
    And the completion body reports setupCompleted true
    And completing setup again founded no additional default hub

  Scenario: Setup refuses a timezone that is not an IANA zone and stays incomplete
    Given the deployment is in its first-run state
    When the admin completes setup with timezone "Not/A_Zone"
    Then the response status should be 400
    And the public config reports setup not completed

  Scenario: Setup endpoints refuse anonymous callers and change nothing
    Given the deployment is in its first-run state
    When an anonymous caller reads the setup state
    Then the response status should be 401
    When an anonymous caller saves wizard progress at step "telephony"
    Then the response status should be 401
    When an anonymous caller completes setup
    Then the response status should be 401
    And the public config reports setup not completed

  Scenario: Setup refuses a user without settings:manage-setup and changes nothing
    Given the deployment is in its first-run state
    And a user with the volunteer role
    When that user reads the setup state
    Then the response status should be 403
    When that user saves wizard progress at step "telephony"
    Then the response status should be 403
    When that user completes setup
    Then the response status should be 403
    And the public config reports setup not completed
