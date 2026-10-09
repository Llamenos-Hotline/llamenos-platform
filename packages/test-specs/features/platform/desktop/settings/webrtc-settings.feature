@desktop
Feature: WebRTC & Call Preference Settings
  As an admin
  I want to configure WebRTC calling and call preferences
  So that volunteers can take calls directly in the browser

  Background:
    Given I am logged in as an admin

  # --- Volunteer Settings: Call Preference ---

  Scenario: Call preference section is visible in volunteer settings
    When I navigate to the "Settings" page
    And I expand the "Call Preference" section
    Then I should see "Phone Only"
    And I should see "Browser Only"
    And I should see "Phone + Browser"

  Scenario: Phone only is selected by default
    When I navigate to the "Settings" page
    And I expand the "Call Preference" section
    Then the "Phone Only" option should be selected

  Scenario: Browser and both options are disabled when WebRTC not configured
    When I navigate to the "Settings" page
    And I expand the "Call Preference" section
    Then I should see a message that browser calling is not available
    And the "Browser Only" option should be disabled
    And the "Phone + Browser" option should be disabled

  Scenario: Deep link to call-preference section auto-expands it
    When I navigate to "/settings?section=call-preference"
    Then I should see "Phone Only"

  # --- Hub Settings: WebRTC Configuration ---

  Scenario: WebRTC config section appears in telephony provider settings
    When I navigate to the "Hub Settings" page
    And I expand the "Telephony Provider" section
    Then I should see "WebRTC Configuration"

  Scenario: WebRTC toggle enables API key fields for Twilio
    When I navigate to the "Hub Settings" page
    And I expand the "Telephony Provider" section
    Then I should not see "API Key SID"
    When I enable the WebRTC toggle
    Then I should see "API Key SID"
    And I should see "API Key Secret"
    And I should see "TwiML App SID"

  Scenario: WebRTC fields not shown for Asterisk provider
    When I navigate to the "Hub Settings" page
    And I expand the "Telephony Provider" section
    And I switch the provider to "asterisk"
    Then I should not see "WebRTC Configuration"

  Scenario: WebRTC toggle shown for SignalWire provider
    When I navigate to the "Hub Settings" page
    And I expand the "Telephony Provider" section
    And I switch the provider to "signalwire"
    Then I should see "WebRTC Configuration"

  # Vonage has no in-app audio in this codebase: its adapter only dials
  # volunteers' phones and the client has no Vonage audio SDK (issue #728).
  Scenario: WebRTC config not offered for Vonage, which rings phones only
    When I navigate to the "Hub Settings" page
    And I expand the "Telephony Provider" section
    And I switch the provider to "vonage"
    Then the in-app audio notice should mark "vonage" as "unsupported"
    And the WebRTC toggle should not be offered
    And I should not see "WebRTC Configuration"

  Scenario: WebRTC config persists with provider save
    When I navigate to the "Hub Settings" page
    And I expand the "Telephony Provider" section
    And I fill in Twilio credentials with WebRTC config
    And I click "Save Provider"
    Then I should see a success message
    When I reload and re-authenticate
    And I navigate to the "Hub Settings" page
    And I expand the "Telephony Provider" section
    Then the WebRTC API key fields should be populated

  # --- initWebRtc honesty (issue #1741) ---

  # No browser audio client SDK is installed anywhere in this repo, so
  # initWebRtc() must never land in `error` (a failed load of an undeclared
  # dependency) or `ready` (nothing to carry the audio). A browser/both
  # volunteer must be told calls ring their phone — the PSTN leg carries
  # real audio — instead of a dead-end error badge. This scenario exists
  # because the ones above only check the settings panel: nothing asserted
  # that initWebRtc() reaches an honest state, which is how the unresolvable
  # `@twilio/voice-sdk` import shipped.
  Scenario: Browser-preference volunteer is told calls ring their phone, never an error
    Given a volunteer with call preference "browser" is logged in
    And the configured provider claims in-app audio
    Then the WebRTC status badge should be "unsupported"
    And the WebRTC status badge should not be "error"
    And the WebRTC status badge should not be "ready"
    And the WebRTC status badge should say that calls ring the phone
