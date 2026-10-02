Feature: In-Call Quick Actions
  Volunteers can ban callers and create notes during active calls
  without navigating away from the call screen.

  # --- Backend API scenarios ---

  @backend @calls @bans
  Scenario: Ban and hang up during active call
    And 2 volunteers are on shift
    And volunteer 0 is on an active call with a unique caller
    When volunteer 0 bans and hangs up the call
    Then the response should indicate the caller was banned
    And the call status should be "completed"
    And the caller should be in the ban list

  @backend @calls @bans
  Scenario: Ban and hang up with custom reason
    And 2 volunteers are on shift
    And volunteer 0 is on an active call with a unique caller
    When volunteer 0 bans and hangs up with reason "Threatening language"
    Then the response should indicate the caller was banned
    And the ban reason should be "Threatening language"

  @backend @calls @bans
  Scenario: Cannot ban another volunteer's call
    And 2 volunteers are on shift
    And volunteer 0 is on an active call with a unique caller
    When volunteer 1 tries to ban and hang up that call
    Then the response status should be 403

  @backend @calls @notes
  Scenario: Create note during active call
    And 2 volunteers are on shift
    And volunteer 0 is on an active call with a unique caller
    When volunteer 0 creates a note for the active call
    Then a note should exist linked to that call ID

  @backend @calls @notes @audit
  Scenario: Answering, noting and banning a call is recorded in the hub's audit log
    And 1 volunteers are on shift
    And an incoming call is ringing for the hub
    When volunteer 0 answers the call through the hub API
    And volunteer 0 creates a note for the active call
    And volunteer 0 bans and hangs up the call
    Then the hub audit log should contain a "callAnswered" entry
    And the hub audit log should contain a "noteCreated" entry
    And the hub audit log should contain a "numberBanned" entry

  # Parallel ringing rings every on-shift volunteer at once, so two volunteers
  # pressing Answer within the same second is ordinary operation. Only the first
  # may take the call. These run against real PostgreSQL, which is the only place
  # the guarded UPDATE is actually exercised.
  @backend @calls
  Scenario: Only the first volunteer to answer gets the call
    And 2 volunteers are on shift
    And an incoming call is ringing for the hub
    When volunteer 0 answers the call through the hub API
    And volunteer 1 also tries to answer the call through the hub API
    Then the response status should be 409
    And the call should still be answered by volunteer 0

  @backend @calls
  Scenario: The answering volunteer may re-answer their own call
    And 1 volunteers are on shift
    And an incoming call is ringing for the hub
    When volunteer 0 answers the call through the hub API
    And volunteer 0 also tries to answer the call through the hub API
    Then the response status should be 200
    And the call should still be answered by volunteer 0

  @backend @calls @bans
  Scenario: Banned caller cannot call back
    And 2 volunteers are on shift
    And volunteer 0 is on an active call with a unique caller
    And volunteer 0 bans and hangs up the call
    When the same caller tries to call again
    Then the call should be rejected

  # --- UI scenarios (desktop + mobile) ---

  @desktop @ios @android @calls @requires-live-calls
  Scenario: Active call panel shows during call
    Given I am logged in as a volunteer on shift
    And I have an active call
    When I view the dashboard
    Then the active call panel should be visible
    And the call timer should be visible

  @desktop @ios @android @calls @bans @requires-live-calls
  Scenario: Ban with custom reason via UI
    Given I am logged in as a volunteer on shift
    And I have an active call
    When I view the dashboard
    And I click the ban button on the active call panel
    Then the ban reason input should be visible
    When I enter ban reason "Threatening language"
    And I confirm the ban
    Then a toast "banned" should appear

  @desktop @ios @android @calls @requires-live-calls
  Scenario: Call panel disappears when call ends
    Given I am logged in as a volunteer on shift
    And I have an active call
    When I view the dashboard
    Then the active call panel should be visible
    When the call ends
    Then the active call panel should not be visible
