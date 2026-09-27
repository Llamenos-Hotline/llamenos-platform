@desktop @ios @android
Feature: Call Routing & History
  As the call routing system
  I want calls to be routed to on-shift volunteers and history to be searchable
  So that callers are connected and records are maintained

  # ── Backend: Telephony Adapter ────────────────────────────────────

  @backend
  Scenario: Twilio adapter requires Account SID, Auth Token, and TwiML App SID
    Given a Twilio provider configuration
    When I validate with missing Account SID
    Then validation should fail with required field error

  @backend
  Scenario: SignalWire adapter requires Space URL and Project ID
    Given a SignalWire provider configuration
    When I validate with all required fields
    Then validation should pass

  @backend
  Scenario: Vonage adapter requires API Key and Secret
    Given a Vonage provider configuration
    When I validate with all required fields
    Then validation should pass

  @backend
  Scenario: Adapter factory returns correct provider type
    Given provider configurations for Twilio and SignalWire
    When the factory creates an adapter for "twilio"
    Then it should return a Twilio adapter instance

  @backend
  Scenario: Invalid provider type returns error
    When the factory is asked for an unknown provider
    Then it should return a configuration error

  @backend
  Scenario: Provider labels are human-readable
    Then each provider should have a display label and icon identifier

  # ── Backend: Shift Routing ────────────────────────────────────────

  @backend
  Scenario: Select ring group from active shift
    Given a shift is currently active with 3 volunteers
    When a call needs to be routed
    Then all 3 volunteers should be in the ring group

  # Busy-volunteer exclusion is asserted against the server's real ring set in
  # demo-mock-telephony.feature (#1018).

  # The fallback group's ring behaviour (which volunteers are actually rung when no shift is
  # active) is asserted against the real ringing service in demo-mock-telephony.feature (#1017).

  @backend
  Scenario: Overlapping shifts merge volunteer pools
    Given two overlapping shifts with different volunteers
    When a call needs to be routed during the overlap
    Then volunteers from both shifts should be in the ring group

  @backend
  Scenario: Empty ring group returns no-volunteers-available
    Given no shift is active and no fallback is configured
    When a call needs to be routed
    Then the router should return a no-volunteers error

  @backend
  Scenario: Shift time zone is respected
    Given a shift configured for 9am-5pm in America/New_York
    When the current time is 10am Eastern
    Then the shift should be considered active

  # ── Backend: Call Simulation Lifecycle ─────────────────────────────

  @backend @desktop @e2e @simulation
  Scenario: Simulate an incoming call
    Given an incoming call from "+15551234567"
    Then the call status should be "ringing"
    And a call ID should be returned

  @backend @desktop @e2e @simulation
  Scenario: Simulate answering a call
    Given an incoming call from "+15551234567"
    When the volunteer answers the call
    Then the call status should be "in-progress"

  @backend @desktop @e2e @simulation
  Scenario: Simulate ending a call
    Given an incoming call from "+15551234567"
    When the volunteer answers the call
    And the call is ended
    Then the call status should be "completed"

  @backend @desktop @e2e @simulation
  Scenario: Simulate a call going to voicemail
    Given an incoming call from "+15559876543"
    When the call goes to voicemail
    Then the call status should be "unanswered"

  @backend @desktop @e2e @simulation
  Scenario: Simulate an incoming call with language preference
    Given an incoming call from "+15551234567" in "es"
    Then the call status should be "ringing"
    And a call ID should be returned

  @backend @desktop @e2e @simulation
  Scenario: Simulate an incoming call for a specific hub
    Given an incoming call from "+15551234567" for hub "test-hub-1"
    Then the call status should be "ringing"
    And a call ID should be returned

  @backend @desktop @e2e @simulation
  Scenario: Simulate answering with a specific volunteer pubkey
    Given an incoming call from "+15551234567"
    When the volunteer with pubkey "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" answers the call
    Then the call status should be "in-progress"

  @backend @desktop @e2e @simulation
  Scenario: Complete call lifecycle - ring, answer, end
    Given an incoming call from "+15557778888"
    Then the call status should be "ringing"
    When the volunteer answers the call
    Then the call status should be "in-progress"
    When the call is ended
    Then the call status should be "completed"

  # ── Backend: Banned caller rejection ──────────────────────────────

  @backend
  Scenario: Banned caller is rejected before ringing
    And "+15559999999" is on the ban list
    When a call arrives from "+15559999999"
    Then the call is rejected
    And no volunteers receive a ring

  @backend
  Scenario: Non-banned caller rings volunteers
    And 2 volunteers are on shift
    When a call arrives from "+15550001111"
    Then the call status is "ringing"

  # ── Backend: Parallel ring & first-pickup-wins ────────────────────

  @backend
  Scenario: All on-shift volunteers ring simultaneously
    And 3 volunteers are on shift
    When a call arrives from "+15552223333"
    Then all 3 volunteers receive a ring

  @backend
  Scenario: First pickup ends ringing for others
    And 2 volunteers are on shift
    When a call arrives from "+15554445555"
    And volunteer 1 answers the call
    Then the call status is "in-progress"
    And volunteer 2 no longer receives a ring

  # ── Backend: Voicemail ────────────────────────────────────────────

  @backend
  Scenario: Unanswered call records voicemail
    And 1 volunteers are on shift
    When a call arrives from "+15556667777"
    And the call goes to voicemail
    Then the call status is "unanswered"

  # ── Backend: Call history ─────────────────────────────────────────

  @backend
  Scenario: Completed call appears in call history
    And 1 volunteers are on shift
    When a call arrives from "+15559876543"
    And volunteer 1 answers the call
    And the call is ended
    Then the call history contains 1 entry
    And the most recent call shows status "completed"
    And the most recent call shows caller "+15559876543"

  @backend
  Scenario: Call history filters by status
    And 1 volunteers are on shift
    And 2 calls were completed today
    And 1 call went to voicemail today
    When the call history is filtered by status "completed"
    Then the call history contains 2 entries

  @backend
  Scenario: Call history filters by date range
    And 1 volunteers are on shift
    And 3 calls were completed today
    When the call history is filtered to today's date
    Then the call history contains 3 entries

  # ── Desktop/Mobile: Call History UI ───────────────────────────────

  @desktop @android @regression
  Scenario: Navigate to call history from dashboard
    Given I am authenticated and on the dashboard
    When I tap the view call history button
    Then I should see the call history screen
    And I should see the call history title

  @desktop @android @regression
  Scenario: Call history displays filter chips
    Given I am authenticated and on the dashboard
    When I tap the view call history button
    Then I should see the "All" call filter chip
    And I should see the "Completed" call filter chip
    And I should see the "Unanswered" call filter chip

  @desktop @android @regression
  Scenario: Call history shows list or empty state
    Given I am authenticated and on the dashboard
    When I tap the view call history button
    Then I should see the call history content or empty state

  @desktop @android @regression
  Scenario: Navigate back from call history
    Given I am authenticated and on the dashboard
    When I tap the view call history button
    And I tap the back button on call history
    Then I should see the dashboard

  @desktop @android @regression
  Scenario: Filter calls by completed status
    Given I am authenticated and on the dashboard
    When I tap the view call history button
    And I tap the "Completed" call filter chip
    Then the "Completed" call filter should be selected

  @desktop @android @regression
  Scenario: Filter calls by unanswered status
    Given I am authenticated and on the dashboard
    When I tap the view call history button
    And I tap the "Unanswered" call filter chip
    Then the "Unanswered" call filter should be selected

  @desktop @android @regression
  Scenario: Reset call filter to all
    Given I am authenticated and on the dashboard
    When I tap the view call history button
    And I tap the "Completed" call filter chip
    And I tap the "All" call filter chip
    Then the "All" call filter should be selected

  @desktop @regression
  Scenario: Status chips list only calls with the selected status
    Given I am authenticated and on the dashboard
    And 2 completed calls and 1 unanswered call exist in the active hub
    When I tap the view call history button
    And I tap the "Completed" call filter chip
    Then the call history lists at least 2 "completed" calls and no other status
    When I tap the "Unanswered" call filter chip
    Then the call history lists at least 1 "unanswered" calls and no other status
    When I tap the "All" call filter chip
    Then the call history lists at least 1 "completed" calls
    And the call history lists at least 1 "unanswered" calls

  @desktop @android @regression
  Scenario: Call history has pull to refresh
    Given I am authenticated and on the dashboard
    When I tap the view call history button
    Then the call history screen should support pull to refresh

  @desktop @android @regression
  Scenario: Call history has search input
    Given I am authenticated and on the dashboard
    When I tap the view call history button
    Then I should see the call history search field

  @desktop @android @regression
  Scenario: Navigate back from call history returns to dashboard
    Given I am authenticated and on the dashboard
    When I tap the view call history button
    Then I should see the call history title
    When I tap the back button on call history
    Then I should see the dashboard

  # ── Desktop/Mobile: Call Date Filter ──────────────────────────────

  @desktop @ios @android @regression
  Scenario: Date range filter chips are visible
    Given I am authenticated and on the main screen
    And I am on the call history screen
    Then I should see the date from filter
    And I should see the date to filter

  @desktop @ios @android @regression
  Scenario: Clear button appears when a date is selected
    Given I am authenticated and on the main screen
    And I am on the call history screen
    And a date range is selected
    Then I should see the date range clear button

  # ── Desktop/Mobile: Call-to-Note Navigation ───────────────────────

  @desktop @ios @android @regression
  Scenario: Add note button is visible on call record cards
    Given I am authenticated and on the main screen
    And I am on the call history screen
    Then each call record should have an add note button

  @desktop @ios @android @regression
  Scenario: Tapping add note navigates to note creation with call context
    Given I am authenticated and on the main screen
    And I am on the call history screen
    When I tap the add note button on a call record
    Then I should see the note creation screen

  # ── Incoming Message Simulation ───────────────────────────────────

  @backend @desktop @e2e @simulation
  Scenario: Simulate an incoming SMS message
    Given an incoming SMS from "+15551112222" with body "I need help"
    Then a conversation ID should be returned
    And a message ID should be returned
    And the simulation should succeed

  @backend @desktop @e2e @simulation
  Scenario: Simulate an incoming WhatsApp message
    Given an incoming WhatsApp message from "+15553334444" with body "Necesito ayuda"
    Then a conversation ID should be returned
    And a message ID should be returned
    And the simulation should succeed

  @backend @desktop @e2e @simulation
  Scenario: Simulate an incoming message with explicit channel
    Given an incoming "sms" message from "+15555556666" with body "Please call me back"
    Then a conversation ID should be returned
    And a message ID should be returned
