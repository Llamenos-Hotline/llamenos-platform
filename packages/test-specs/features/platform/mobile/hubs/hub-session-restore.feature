@ios
Feature: Hub membership loads with the session (iOS)
  The app must learn the user's hubs when the session becomes usable —
  sign-in, PIN unlock, session restore — not only when the user visits
  Settings → Hubs. The multi-hub routing axiom depends on it: calls, push
  notifications and relay events arrive from every member hub regardless of
  which hub is active, and hub-scoped actions (clock-in, notes, shifts)
  need an active hub that actually belongs to the user.
  (#1720 — until it, the only GET /api/hubs call site was Settings → Hubs.)

  Scenario: Unlocking the app loads member hubs
    Given a volunteer with stored identity and hub membership
    When they unlock the app with their PIN
    Then the app fetches the member hub list from the authenticated API
    And an active hub is selected without opening hub settings

  Scenario: Completing onboarding loads member hubs
    Given a volunteer who just created or linked their identity
    When onboarding completes and the session becomes usable
    Then the app fetches the member hub list from the authenticated API

  Scenario: Hub keys load for every member hub when the session starts
    Given a volunteer who belongs to multiple hubs
    When the session becomes usable
    Then the hub key of every member hub is fetched and cached
    And encrypted content is decryptable without opening hub settings

  Scenario: A stale active hub is replaced on session restore
    Given the persisted active hub is one the user is no longer a member of
    When the session becomes usable
    Then the active hub is replaced with a current membership

  Scenario: Clock in works without opening hub settings
    Given a volunteer who has never opened the hub management screen
    When they restore their session and open the shifts tab
    Then they can clock in to their hub
