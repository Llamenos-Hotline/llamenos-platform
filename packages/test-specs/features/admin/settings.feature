@desktop @ios @android
Feature: Admin & User Settings
  As an admin or user
  I want to manage hub-level and user-level settings
  So that the organization is configured correctly and my preferences are saved

  # ── Admin Settings ────────────────────────────────────────────────

  @desktop @ios @android @regression
  Scenario: Admin settings tab shows transcription card
    Given I am logged in as an admin
    And I navigate to the admin settings tab
    Then I should see the transcription settings card

  @desktop @ios @android @regression
  Scenario: Transcription toggle controls global transcription
    Given I am logged in as an admin
    And I navigate to the admin settings tab
    Then I should see the transcription enabled toggle
    And I should see the transcription opt-out toggle

  @desktop @ios @android @regression
  Scenario: Toggling transcription updates the setting
    Given I am logged in as an admin
    And I navigate to the admin settings tab
    When I toggle transcription on
    Then transcription should be enabled

  # ── Admin Tabs ────────────────────────────────────────────────────

  @desktop @ios @android @regression
  Scenario: All admin tabs are present
    Given I am authenticated
    And I have navigated to the admin panel
    Then I should see the following tabs:
      | tab         |
      | Volunteers  |
      | Ban List    |
      | Audit Log   |
      | Shifts      |

  @desktop @ios @android @regression
  Scenario: Default tab is Volunteers
    Given I am authenticated
    And I have navigated to the admin panel
    Then the "Volunteers" tab should be selected by default
    And volunteers content should be displayed (loading, empty, or list)

  @desktop @ios @android @regression
  Scenario Outline: Switch to admin tab
    Given I am authenticated
    And I have navigated to the admin panel
    When I tap the "<tab>" tab
    Then <tab_content> content should be displayed (loading, empty, or list)

    Examples:
      | tab        | tab_content  |
      | Ban List   | bans         |
      | Audit Log  | audit        |
      | Shifts     | shifts       |

  @desktop @ios @android @regression
  Scenario: Switch between all tabs without crash
    Given I am authenticated
    And I have navigated to the admin panel
    When I tap "Ban List"
    And I tap "Audit Log"
    And I tap "Shifts"
    And I tap "Volunteers"
    Then I should be on the Volunteers tab
    And no crashes should occur

  # ── Admin Navigation ──────────────────────────────────────────────

  @desktop @ios @android @smoke
  Scenario: Navigate to admin panel
    Given I am authenticated
    And I am on the settings screen
    When I scroll to and tap the admin card
    Then I should see the admin screen
    And the admin title should be displayed
    And the admin tabs should be visible

  @desktop @ios @android @smoke
  Scenario: Admin back navigation returns to settings
    Given I am authenticated
    And I am on the settings screen
    When I navigate to the admin panel
    And I tap the back button
    Then I should return to the settings screen
    And the settings identity card should be visible

  # ── Demo Mode ─────────────────────────────────────────────────────

  @desktop @ios @android
  Scenario: Summary step shows demo mode toggle
    Given I am logged in as an admin
    When I navigate to the setup wizard summary step
    Then I should see a "Populate with sample data" toggle
    And the toggle should be off by default

  @desktop @ios @android @fixme
  # fixme: the 500 this scenario was blocked on (#1197) is fixed and verified
  # end-to-end — but demo accounts get seeded into a different hub than the one
  # this scenario reads from afterward (SetupWizard.tsx picks the server-wide
  # config.hubs[0] rather than this session's own hub). Tracked separately — #1457
  Scenario: Complete setup with demo mode creates demo accounts
    Given I am logged in as an admin
    When I navigate to the setup wizard summary step
    And I enable the demo mode toggle
    And I click "Go to Dashboard"
    Then I should be redirected to the dashboard
    When I navigate to the "Volunteers" page
    Then I should see "Maria Santos"
    And I should see "James Chen"
    And I should see "Community Reporter"
    And I should see "Fatima Al-Rashid"

  @desktop @ios @android
  Scenario: Login page shows demo account picker when demo mode is enabled
    Given demo mode has been enabled
    When I visit the login page
    Then I should see "Try the demo"
    And I should see "Pick a demo account to explore"
    And I should see "Demo Admin"
    And I should see "Maria Santos"
    And I should see "James Chen"
    And I should see "Demo data resets daily"

  @desktop @ios @android @fixme
  # fixme: same hub-resolution gap as "Complete setup with demo mode creates
  # demo accounts" above — not the #1197 500 (fixed). Tracked as #1457
  Scenario: Clicking demo account logs in and redirects to dashboard
    Given demo mode has been enabled
    When I visit the login page
    And I click the "Maria Santos" demo account
    Then I should be redirected away from login
    And the navigation should show "Maria Santos"

  @desktop @ios @android
  Scenario: Demo banner shows when logged in
    Given demo mode has been enabled
    And I am logged in as an admin
    Then I should see "Test environment — do not enter real caller information. Data here is not confidential and may be deleted at any time."
    When I dismiss the demo banner
    Then "Test environment — do not enter real caller information. Data here is not confidential and may be deleted at any time." should no longer be visible

  @desktop @ios @android @fixme
  # fixme: same hub-resolution gap as "Complete setup with demo mode creates
  # demo accounts" above — not the #1197 500 (fixed). Tracked as #1457
  Scenario: Demo shifts are populated
    Given demo mode has been enabled
    And I am logged in as an admin
    When I navigate to the "Shifts" page
    Then I should see "Morning Team"
    And I should see "Evening Team"
    And I should see "Weekend Coverage"

  @desktop @ios @android @requires-demo
  Scenario: Demo bans are populated
    Given demo mode has been enabled
    And I am logged in as an admin
    When I navigate to the "Ban List" page
    Then I should see "Repeated prank calls"
    And I should see "Threatening language"

  # ── Settings Display ──────────────────────────────────────────────

  @desktop @ios @android @smoke
  Scenario: Settings tab displays identity card
    Given I am authenticated and on the main screen
    When I tap the "Settings" tab
    Then the settings identity card should be visible
    And I should see my npub in monospace text
    And I should see the copy npub button

  @desktop @ios @android @smoke
  Scenario: Settings shows hub connection info
    Given I am authenticated and on the main screen
    When I tap the "Settings" tab
    Then I should see the hub connection card
    And the connection status should be displayed

  @desktop @ios @android @smoke
  Scenario: Settings shows device link card
    Given I am authenticated and on the main screen
    When I tap the "Settings" tab
    Then I should see the device link card (may need scroll)
    And the device link card should be tappable

  @desktop @ios @android @smoke
  Scenario: Settings shows admin card
    Given I am authenticated and on the main screen
    When I tap the "Settings" tab
    Then I should see the admin card (may need scroll)
    And the admin card should be tappable

  @desktop @ios @android @smoke
  Scenario: Settings shows lock and logout buttons
    Given I am authenticated and on the main screen
    When I tap the "Settings" tab
    Then I should see the "Lock App" button
    And I should see the "Log Out" button

  @desktop @ios @android @smoke
  Scenario: Settings shows version text
    Given I am authenticated and on the main screen
    When I tap the "Settings" tab
    Then I should see the version text

  # ── Lock & Logout ─────────────────────────────────────────────────

  @desktop @ios @android @regression
  Scenario: Lock app returns to PIN unlock
    Given I am authenticated
    And I am on the settings screen
    When I tap "Lock App"
    Then I should see the PIN unlock screen
    And the crypto service should be locked

  @desktop @ios @android @regression
  Scenario: Logout shows confirmation dialog
    Given I am authenticated
    And I am on the settings screen
    When I tap "Log Out"
    Then I should see the logout confirmation dialog
    And I should see "Confirm" and "Cancel" buttons

  @desktop @ios @android @regression
  Scenario: Cancel logout dismisses dialog
    Given I am authenticated
    And I am on the settings screen
    When I tap "Log Out"
    And I tap "Cancel"
    Then the dialog should be dismissed
    And I should remain on the settings screen

  # @fixme: logout keeps the encrypted device keys the dialog says it removes — #1305
  @desktop @ios @android @regression @fixme
  Scenario: Confirm logout clears identity
    Given I am authenticated
    And I am on the settings screen
    When I tap "Log Out"
    And I tap "Confirm"
    Then I should return to the login screen
    And no stored keys should remain
    And the crypto service should be locked

  # ── Profile Settings ──────────────────────────────────────────────

  # @fixme: races other admin scenarios that save the shared admin profile (passes alone) — #1315
  @desktop @ios @android @fixme
  Scenario: Admin can edit profile name and it persists
    Given I am logged in as an admin
    When I navigate to the "Settings" page
    And I change my display name
    And I click "Update Profile"
    Then I should see "Profile updated"
    When I reload and re-authenticate
    Then the new display name should persist

  @desktop @ios @android
  Scenario: Admin can save a valid phone number
    Given I am logged in as an admin
    When I navigate to the "Settings" page
    And I enter a valid phone number
    And I click "Update Profile"
    Then I should see "Profile updated"

  @desktop @ios @android
  Scenario: Profile rejects invalid phone
    Given I am logged in as an admin
    When I navigate to the "Settings" page
    And I enter an invalid phone number "+123"
    And I click "Update Profile"
    Then I should see "invalid phone"

  @desktop @ios @android
  Scenario: Volunteer sees profile card in settings
    Given a volunteer is logged in
    When they navigate to the "Settings" page
    Then they should see the "Profile" section
    And they should see a name input
    And they should see a phone input
    And they should see their public key

  @desktop @ios @android
  Scenario: Admin sees key backup in user settings
    Given I am logged in as an admin
    When I navigate to the "Settings" page
    Then I should see the "Key Backup" section

  @desktop @ios @android
  Scenario: Admin sees spam mitigation in hub settings
    Given I am logged in as an admin
    When I navigate to the "Hub Settings" page
    Then I should see the "Spam Mitigation" section

  @desktop @ios @android
  Scenario: Admin sees passkeys in user settings
    Given I am logged in as an admin
    When I navigate to the "Settings" page
    Then I should see the "Passkeys" section

  @desktop @ios @android
  Scenario: Volunteer does not see admin settings link
    Given a volunteer is logged in
    When they navigate to the "Settings" page
    Then they should not see a "Hub Settings" link
    And they should not see "Passkey Policy"
    And they should not see "Spam Mitigation"

  @desktop @ios @android
  Scenario: Volunteer can update name and phone
    Given a volunteer is logged in
    When they navigate to the "Settings" page
    And they update their name and phone
    And they click "Update Profile"
    Then they should see "Profile updated"

  @desktop @ios @android
  Scenario: Spoken language selection works
    Given I am logged in as an admin
    When I navigate to the "Settings" page
    And I toggle a language option
    And I click "Update Profile"
    Then I should see "Profile updated"

  @desktop @ios @android
  Scenario: Deep link expands and scrolls to section
    Given I am logged in as an admin
    When I navigate to "/settings?section=transcription"
    Then the transcription section should be expanded

  @desktop @ios @android
  Scenario: Sections collapse and expand on click
    Given I am logged in as an admin
    When I navigate to the "Settings" page
    Then the profile section should be expanded
    When I click the "Profile" header
    Then the profile section should collapse
    When I click the "Profile" header again
    Then the profile section should expand

  @desktop @ios @android
  Scenario: Multiple sections can be open simultaneously
    Given I am logged in as an admin
    When I navigate to the "Settings" page
    And I expand the "Transcription" section
    Then both "Profile" and "Transcription" sections should be visible

  @desktop @ios @android
  Scenario: Copy link button is present on each section
    Given I am logged in as an admin
    When I navigate to the "Settings" page
    Then each settings section should have a "Copy Link" button

  # ── Theme ─────────────────────────────────────────────────────────

  @desktop @ios @android
  Scenario: Can switch to dark theme
    Given I am logged in as an admin
    When I click the dark theme button
    Then the page should have the "dark" class

  @desktop @ios @android
  Scenario: Can switch to light theme
    Given I am logged in as an admin
    When I click the light theme button
    Then the page should not have the "dark" class

  @desktop @ios @android
  Scenario: Can switch to system theme
    Given I am logged in as an admin
    When I click the system theme button
    Then the page should render without errors

  @desktop @ios @android
  Scenario: Theme persists across page reload
    Given I am logged in as an admin
    When I click the dark theme button
    And I reload and re-authenticate
    Then the page should have the "dark" class

  @desktop @ios @android
  Scenario: Login page has theme toggle
    Given I am logged in as an admin
    When I log out
    Then I should see the dark theme button on the login page
    And I should see the light theme button on the login page
    And I should see the system theme button on the login page

  @desktop @ios @android
  Scenario: Dark theme persists across SPA navigation
    Given I am logged in as an admin
    When I click the dark theme button
    And I navigate to the "Volunteers" page
    Then the page should have the "dark" class
    When I navigate to the "Audit Log" page
    Then the page should have the "dark" class
    When I navigate to the "Dashboard" page
    Then the page should have the "dark" class

  # ── Language Selection ────────────────────────────────────────────

  @desktop @ios @android
  Scenario: Language section visible in settings
    Given the app is launched
    And I tap the "Settings" tab
    When I expand the language section
    Then I should see the language options

  @desktop @ios @android
  Scenario: Language chips display all supported languages
    Given the app is launched
    And I tap the "Settings" tab
    When I expand the language section
    Then I should see language chips for all supported locales

  @desktop @ios @android
  Scenario: Select a language
    Given the app is launched
    And I tap the "Settings" tab
    When I expand the language section
    And I tap a language chip
    Then the language chip should be selected

  @desktop @ios @android
  Scenario: Spoken languages section visible in profile
    Given the app is launched
    And I tap the "Settings" tab
    When I expand the profile section
    Then I should see the spoken languages chips

  # @fixme: spoken-language chips expose no aria-pressed state — #1308
  @desktop @ios @android @fixme
  Scenario: Toggle spoken language selection
    Given the app is launched
    And I tap the "Settings" tab
    When I expand the profile section
    And I tap a spoken language chip
    Then the spoken language chip should be selected

  # ── Notifications ─────────────────────────────────────────────────

  @desktop @android @regression
  Scenario: Notifications section is visible in settings
    Given I am authenticated and on the main screen
    When I tap the "Settings" tab
    Then I should see the notifications section

  @desktop @android @regression
  Scenario: Notification toggles are displayed
    Given I am authenticated and on the main screen
    When I tap the "Settings" tab
    And I expand the "notifications" section
    Then I should see the notification toggles

  # ── Key Backup ────────────────────────────────────────────────────

  @desktop @android @regression
  Scenario: Key backup section is visible in settings
    Given I am authenticated and on the main screen
    When I tap the "Settings" tab
    Then I should see the key backup section

  @desktop @android @regression
  Scenario: Key backup shows security warning
    Given I am authenticated and on the main screen
    When I tap the "Settings" tab
    And I expand the "key backup" section
    Then I should see the key backup warning

  # ── Transcription Preferences ─────────────────────────────────────

  @desktop @ios @android @regression
  Scenario: Transcription section is visible in settings
    Given I am authenticated and on the main screen
    And I am on the settings screen
    And I expand the transcription section
    Then I should see the transcription settings section

  @desktop @ios @android @regression
  Scenario: Transcription toggle is visible when opt-out allowed
    Given I am authenticated and on the main screen
    And I am on the settings screen
    And I expand the transcription section
    Then I should see the transcription toggle

  @desktop @ios @android @regression
  Scenario: Managed message shows when opt-out not allowed
    Given I am authenticated and on the main screen
    And I am on the settings screen
    And I expand the transcription section
    And transcription opt-out is not allowed
    Then I should see the transcription managed message

  # ── Advanced Settings ─────────────────────────────────────────────

  @desktop @ios @android @regression
  Scenario: Advanced settings section shows auto-lock options
    Given I am authenticated and on the main screen
    And I am on the settings screen
    And I expand the advanced settings section
    Then I should see the auto-lock timeout options

  @desktop @ios @android @regression
  Scenario: Advanced settings section shows debug logging toggle
    Given I am authenticated and on the main screen
    And I am on the settings screen
    And I expand the advanced settings section
    Then I should see the debug logging toggle

  @desktop @ios @android @regression
  Scenario: Advanced settings section shows clear cache button
    Given I am authenticated and on the main screen
    And I am on the settings screen
    And I expand the advanced settings section
    Then I should see the clear cache button

  @desktop @ios @android @regression
  Scenario: Clear cache shows confirmation dialog
    Given I am authenticated and on the main screen
    And I am on the settings screen
    And I expand the advanced settings section
    When I tap the clear cache button
    Then I should see the clear cache confirmation dialog

  # ── Emergency Wipe ────────────────────────────────────────────────

  @desktop @ios @android @regression
  Scenario: Emergency wipe button is visible
    Given I am on the settings screen
    Then I should see the emergency wipe button

  @desktop @ios @android @regression
  Scenario: Emergency wipe shows confirmation dialog
    Given I am on the settings screen
    When I tap the emergency wipe button
    Then I should see the emergency wipe confirmation dialog
    And the dialog should warn about permanent data loss

  @desktop @ios @android @regression
  Scenario: Confirming emergency wipe clears all data
    Given I am on the settings screen
    When I tap the emergency wipe button
    And I confirm the emergency wipe
    Then all local data should be erased
    And I should be returned to the login screen

  @desktop @ios @android @regression
  Scenario: Cancelling emergency wipe keeps data intact
    Given I am on the settings screen
    When I tap the emergency wipe button
    And I cancel the emergency wipe
    Then the confirmation dialog should close
    And I should still be on the settings screen

  # ── Device Linking ────────────────────────────────────────────────

  @desktop @ios @android @regression @requires-camera
  Scenario: Device link screen shows step indicator
    Given I am authenticated
    And I navigate to the device link screen from settings
    Then I should see the step indicator
    And I should see step labels (Scan, Verify, Import)
    And the current step should be "Scan"

  @desktop @ios @android @regression @requires-camera
  Scenario: Device link shows camera or permission prompt
    Given I am authenticated
    And I navigate to the device link screen from settings
    Then I should see either the camera preview or the camera permission prompt

  @desktop @ios @android @regression @requires-camera
  Scenario: Camera permission denied shows request button
    Given I am authenticated
    And I navigate to the device link screen from settings
    And camera permission is not granted
    Then I should see the "Request Camera Permission" button

  @desktop @ios @android @regression @requires-camera
  Scenario: Invalid QR code shows error
    Given I am authenticated
    And I navigate to the device link screen from settings
    When a QR code with invalid format is scanned
    Then I should see the error state
    And the error message should mention "Invalid QR code format"
    And I should see "Retry" and "Cancel" buttons

  @desktop @ios @android @regression
  Scenario: Cancel device link returns to settings
    Given I am authenticated
    And I navigate to the device link screen from settings
    When I tap the back button
    Then I should return to the settings screen

  @desktop @ios @android @regression
  Scenario: Device link back navigation
    Given I am authenticated
    And I navigate to the device link screen from settings
    When I tap the back button
    Then I should see the settings screen
    And the device link card should still be visible

  # @fixme: desktop Settings is the approving side of device linking — #1313
  @desktop @ios @android @regression @fixme
  Scenario: Device link shows QR code
    Given I am authenticated
    And I navigate to the device link screen from settings
    When I start the device linking process
    Then I should see a QR code displayed

  # @fixme: desktop Settings is the approving side of device linking — #1313
  @desktop @ios @android @regression @fixme
  Scenario: Device link shows progress steps
    Given I am authenticated
    And I navigate to the device link screen from settings
    When I start the device linking process
    Then I should see the linking progress indicator

  # @fixme: desktop Settings is the approving side of device linking — #1313
  @desktop @ios @android @regression @fixme
  Scenario: Cancel device linking
    Given I am authenticated
    And I navigate to the device link screen from settings
    When I start the device linking process
    And I cancel the linking
    Then I should return to the settings screen

  # @fixme: desktop Settings is the approving side of device linking — #1313
  @desktop @ios @android @regression @fixme
  Scenario: Device link timeout handling
    Given I am authenticated
    And I navigate to the device link screen from settings
    When I start the device linking process
    And the provisioning room expires
    Then I should see a timeout error message

  @desktop @ios @android @regression @security @requires-camera
  Scenario: QR code with localhost relay shows error
    Given I am authenticated
    And I navigate to the device link screen from settings
    When a QR code with relay URL "wss://localhost:4869" is scanned
    Then I should see the error state
    And the error message should mention private or local network

  @desktop @ios @android @regression @security @requires-camera
  Scenario: QR code with private IP relay shows error
    Given I am authenticated
    And I navigate to the device link screen from settings
    When a QR code with relay URL "wss://192.168.1.100:4869" is scanned
    Then I should see the error state
    And the error message should mention private or local network

  @desktop @ios @android @regression @security @requires-camera
  Scenario: QR code with valid public relay proceeds
    Given I am authenticated
    And I navigate to the device link screen from settings
    When a QR code with relay URL "wss://relay.llamenos.org" is scanned
    Then I should not see a relay URL error
    And the step should advance to "Verify"
