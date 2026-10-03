@desktop @ios @android
Feature: Authentication & Login
  As a user
  I want to authenticate securely with my Nostr keypair
  So that my identity is protected and verified

  # ── Backend: Auth Verification ────────────────────────────────────

  @backend
  Scenario: Valid Schnorr-signed token is accepted
    Given a user with a valid keypair
    When the user creates a signed auth token
    Then the server should verify the token successfully

  @backend
  Scenario: Expired token is rejected
    Given a user with a valid keypair
    When the user presents a token older than 5 minutes
    Then the server should reject the token with 401

  @backend
  Scenario: Token with invalid signature is rejected
    Given a tampered auth token
    When the token is presented to the server
    Then the server should reject the token with 401

  @backend
  Scenario: Token with wrong pubkey is rejected
    Given a token signed by an unregistered pubkey
    When the token is presented to the server
    Then the server should reject the token with 401

  @backend
  Scenario: Session token validates WebAuthn credential
    Given a user with a registered WebAuthn credential
    When the user presents a valid session token
    Then the server should accept the session

  @backend
  Scenario: Missing Authorization header returns 401
    When a request is made without any auth header
    Then the server should respond with 401

  # ── Backend: Permission System ────────────────────────────────────

  @backend
  Scenario: Super Admin has wildcard access
    Given a user with the "Super Admin" role
    Then they should pass permission checks for any action

  @backend
  Scenario: Volunteer has limited permissions
    Given a user with the "Volunteer" role
    Then they should pass permission checks for "notes:create"
    And they should fail permission checks for "admin:settings"

  @backend
  Scenario: Reporter can only create reports
    Given a user with the "Reporter" role
    Then they should pass permission checks for "reports:create"
    And they should fail permission checks for "notes:read"

  @backend
  Scenario: Domain wildcard grants all actions in domain
    Given a role with "notes:*" permission
    Then it should grant "notes:create" and "notes:read" and "notes:delete"

  @backend
  Scenario: Multi-role user gets union of permissions
    Given a user with "Volunteer" and "Reviewer" roles
    Then they should have permissions from both roles combined

  @backend
  Scenario: Hub-scoped permissions restrict to specific hub
    Given a user with hub-scoped admin permissions
    Then they should only have admin access to their assigned hub

  @backend
  Scenario: Custom role grants only specified permissions
    Given a custom role with "calls:answer" and "notes:create" permissions
    Then the user should pass checks for those permissions only

  # ── Desktop/Mobile: Login Screen ──────────────────────────────────

  @desktop @ios @android @smoke
  Scenario: Login screen displays recovery elements
    Given the app is freshly installed
    And no identity exists on the device
    When the app launches
    Then I should see the device key import input field
    And I should see a "Log in" button

  @desktop @ios @android @smoke
  Scenario: Device key input is password-masked
    Given the app is freshly installed
    And no identity exists on the device
    When I enter "test-key-input" in the device key field
    Then the device key field should be a password field

  @desktop @ios @android @regression
  Scenario: Login with empty device key shows error
    Given the app is freshly installed
    And no identity exists on the device
    When I tap "Log in" without entering a device key
    Then I should see an error message
    And I should remain on the login screen

  @desktop @ios @android @regression
  Scenario: Login with invalid device key shows error
    Given the app is freshly installed
    And no identity exists on the device
    When I enter "not-a-valid-key" in the device key field
    And I tap "Log in"
    Then I should see an error message
    And I should remain on the login screen

  @desktop @ios @android @regression
  Scenario: Login with valid device key navigates away from login
    Given the app is freshly installed
    And no identity exists on the device
    When I enter a valid 63-character device key
    And I tap "Log in"
    Then I should be redirected away from login

  # ── Desktop/Mobile: Onboarding ────────────────────────────────────

  @desktop @ios @android @smoke
  Scenario: Valid device key login navigates to dashboard
    Given the app is freshly installed
    And I am on the login screen
    When I enter a valid 63-character device key
    And I tap "Log in"
    Then I should be redirected away from login

  @desktop @ios @android @smoke
  Scenario: Nsec field shows password type
    Given the app is freshly installed
    And I am on the login screen
    When I enter "nsec1test" in the device key field
    Then the device key field should be a password field

  @desktop @ios @android @smoke
  Scenario: Link device button is visible
    Given the app is freshly installed
    And I am on the login screen
    Then I should see a "Link this device" button

  # ── Desktop/Mobile: PIN Setup ─────────────────────────────────────

  @desktop @ios @android @smoke
  Scenario: PIN pad displays correctly
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    Then I should see the PIN pad with digits 0-9
    And I should see the PIN dots indicator

  @desktop @ios @android @smoke
  Scenario: Correct PIN unlocks to dashboard
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    When I enter PIN "12345678"
    Then I should arrive at the dashboard
    And the dashboard title should be displayed
    And the bottom navigation should be visible

  @desktop @ios @android @smoke
  Scenario: Wrong PIN shows error
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    When I enter PIN "99999900"
    Then I should remain on the unlock screen
    And the PIN dots should be cleared

  @desktop @ios @android @regression
  Scenario: Backspace removes entered digit
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    When I press "1", "2"
    And I press backspace
    And I press "3", "4", "5"
    Then 4 digits should be entered

  @desktop @ios @android @regression
  Scenario: PIN is encrypted and stored
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    When I enter PIN "12345678"
    Then the encrypted key data should be stored
    And the pubkey should be stored for locked display
    And the npub should be stored for locked display

  # ── Desktop/Mobile: PIN Unlock ────────────────────────────────────

  @desktop @ios @android @smoke
  Scenario: Unlock screen displays for returning user
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    When the app launches
    Then I should see the PIN unlock screen
    And the title should indicate "Unlock"
    And the PIN pad should be displayed

  @desktop @ios @android @smoke
  Scenario: Correct PIN unlocks the app
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    When I enter PIN "12345678"
    Then I should arrive at the dashboard
    And the crypto service should be unlocked

  @desktop @ios @android @smoke
  Scenario: Wrong PIN shows error on unlock
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    When I enter PIN "99999900"
    Then I should see a PIN error message
    And I should remain on the unlock screen
    And the PIN dots should be cleared

  @desktop @ios @android @regression
  Scenario: Multiple wrong PINs allow retry
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    When I enter PIN "00000000"
    And I see the error
    And I enter PIN "11111100"
    And I see the error
    And I enter PIN "12345678"
    Then I should arrive at the dashboard

  @desktop @ios @android @regression
  Scenario: Recovery options accessible from unlock screen
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    When I tap "Recovery options"
    Then I should see the device key import input field

  # ── Desktop/Mobile: PIN Lockout ───────────────────────────────────

  @desktop @ios @android @security
  Scenario: First four wrong PINs allow immediate retry
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    When I enter PIN "00000000"
    Then I should see a PIN error message
    And I should not see a lockout timer
    When I enter PIN "11111100"
    Then I should see a PIN error message
    And I should not see a lockout timer
    When I enter PIN "22222200"
    Then I should see a PIN error message
    And I should not see a lockout timer
    When I enter PIN "33333300"
    Then I should see a PIN error message
    And I should not see a lockout timer

  @desktop @ios @android @security
  Scenario: Fifth wrong PIN triggers 30-second lockout
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    And I have 4 failed PIN attempts
    When I enter PIN "00000000"
    Then I should see a lockout message
    And the lockout duration should be approximately 30 seconds
    And the PIN pad should be disabled

  @desktop @ios @android @security
  Scenario: Seventh wrong PIN triggers 2-minute lockout
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    And I have 6 failed PIN attempts
    When I enter PIN "00000000"
    Then I should see a lockout message
    And the lockout duration should be approximately 2 minutes
    And the PIN pad should be disabled

  @desktop @ios @android @security
  Scenario: Ninth wrong PIN triggers 10-minute lockout
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    And I have 8 failed PIN attempts
    When I enter PIN "00000000"
    Then I should see a lockout message
    And the lockout duration should be approximately 10 minutes

  @desktop @ios @android @security @destructive
  Scenario: Tenth wrong PIN wipes all keys
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    And I have 9 failed PIN attempts
    When I enter PIN "00000000"
    Then the stored keys should be wiped
    And I should be redirected to the setup or login screen

  @desktop @ios @android @security
  Scenario: Correct PIN resets attempt counter
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    And I have 3 failed PIN attempts
    When I enter PIN "12345678"
    Then I should arrive at the dashboard
    And the failed attempt counter should be reset

  @desktop @ios @android @security
  Scenario: Lockout persists after app restart
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    And I have 5 failed PIN attempts
    And I see the lockout message
    When the app is restarted
    Then I should still see the lockout message
    And I should not be able to enter a PIN until lockout expires

  @desktop @ios @android @security
  Scenario: After lockout expires, retry is allowed
    Given I have a stored identity with PIN "12345678"
    And the app is restarted
    And I have 5 failed PIN attempts
    And the lockout has expired
    When I enter PIN "12345678"
    Then I should arrive at the dashboard

  # ── Desktop/Mobile: Key Import ────────────────────────────────────

  @desktop @ios @android @regression
  Scenario: Import valid device key logs in successfully
    Given the app is freshly installed
    And I am on the login screen
    When I enter a valid 63-character device key
    And I tap "Log in"
    Then I should be redirected away from login

  # @fixme: typing in the device key field does not clear the login error — #1307
  @desktop @ios @android @regression @fixme
  Scenario: Error clears when typing in device key field
    Given the app is freshly installed
    And I am on the login screen
    When I tap "Log in"
    And I should see an error message
    And I start typing in the device key field
    Then the error should disappear

  # ── Desktop/Mobile: Invite Onboarding ─────────────────────────────
  # Desktop invite → paste → redeem is covered end to end, from a fresh
  # install, in platform/desktop/auth/invite-redemption.feature.

  @ios @android
  Scenario: Admin creates invite and volunteer completes onboarding
    Given I am logged in as an admin
    And I navigate to the "Volunteers" page
    When I create an invite for a new volunteer
    Then an invite link should be generated
    When the volunteer opens the invite link
    Then they should see a welcome screen with their name
    When the volunteer completes the onboarding flow
    Then they should arrive at the profile setup or dashboard

  @desktop @ios @android
  Scenario: Invalid invite code shows error
    When I navigate to "/onboarding?code=invalidcode123"
    Then I should see "Invalid invite"

  # Desktop opens the paste-your-code screen here instead (invite-redemption.feature).
  @ios @android
  Scenario: Missing invite code shows error
    When I navigate to "/onboarding"
    Then I should see "No invite code"

  @desktop @ios @android
  Scenario: Admin can see pending invites and revoke them
    Given I am logged in as an admin
    And I navigate to the "Volunteers" page
    When I create an invite for a new volunteer
    And I dismiss the invite link card
    Then the volunteer name should appear in the pending invites list
    When I revoke the invite
    Then the volunteer name should no longer appear in the list

  # ── Desktop/Mobile: Form Validation ───────────────────────────────

  @desktop @ios @android
  Scenario: Volunteer form rejects invalid phone
    Given I am logged in as an admin
    When I navigate to the "Volunteers" page
    And I click "Add Volunteer"
    And I fill in name with "Test"
    And I fill in phone with "+123"
    And I click "Save"
    Then I should see "invalid phone"

  @desktop @ios @android
  Scenario: Volunteer form rejects phone without plus prefix
    Given I am logged in as an admin
    When I navigate to the "Volunteers" page
    And I click "Add Volunteer"
    And I fill in name with "Test"
    And I fill in phone with "1234"
    And I click "Save"
    Then I should see "invalid phone"

  @desktop @ios @android
  Scenario: Volunteer form accepts valid E.164 phone
    Given I am logged in as an admin
    When I navigate to the "Volunteers" page
    And I click "Add Volunteer"
    And I fill in name with "Valid Phone Test"
    And I fill in a valid phone number
    And I click "Save"
    Then I should see the volunteer device key

  @desktop @ios @android
  Scenario: Ban form rejects invalid phone
    Given I am logged in as an admin
    When I navigate to the "Ban List" page
    And I click "Ban Number"
    And I fill in phone with "+123"
    And I fill in reason with "Test reason"
    And I click "Save"
    Then I should see "invalid phone"

  @desktop @ios @android
  Scenario: Login rejects key without valid prefix
    Given I am logged in as an admin
    When I log out
    And I click "Recovery Options"
    And I enter "npub1abc123" in the device key field
    And I click "Log In"
    Then I should see "invalid"

  @desktop @ios @android
  Scenario: Login rejects very short device key
    Given I am logged in as an admin
    When I log out
    And I click "Recovery Options"
    And I enter "nsec1short" in the device key field
    And I click "Log In"
    Then I should see "invalid"

  @desktop @ios @android
  Scenario: Bulk ban import validates phone format
    Given I am logged in as an admin
    When I navigate to the "Ban List" page
    And I click "Import"
    And I paste invalid phone numbers in the textarea
    And I fill in reason with "Test reason"
    And I click "Submit"
    Then I should see "invalid phone"

  # ── Desktop/Mobile: Panic Wipe ────────────────────────────────────

  @desktop @ios @android @smoke
  Scenario: Triple-Escape triggers panic wipe
    Given I am logged in as an admin
    And I am on the dashboard
    When I press Escape three times quickly
    Then the panic wipe overlay should appear
    And I should be redirected to the login page
    And all local storage should be cleared
    And all session storage should be cleared

  @desktop @ios @android @smoke
  Scenario: Two Escapes then pause does not trigger wipe
    Given I am logged in as an admin
    And I am on the dashboard
    When I press Escape twice then wait over one second
    And I press Escape once more
    Then I should still be on the dashboard
    And the encrypted key should still be in storage

  # ── Desktop/Mobile: Access Control ────────────────────────────────

  @desktop @ios @android @regression
  Scenario: Locked state restricts to PIN unlock only
    Given the crypto service is locked
    And a stored identity exists
    Then I should see the PIN unlock screen
    And the bottom navigation should not be visible
    And I should not be able to access any tab

  @desktop @ios @android @regression
  Scenario: Unlocked state provides full app access
    Given I am authenticated and on the dashboard
    Then the bottom navigation should be visible
    And I should be able to navigate to all tabs:
      | tab           |
      | Dashboard     |
      | Notes         |
      | Conversations |
      | Shifts        |
      | Settings      |

  # @fixme: desktop encryptNote succeeds while locked; needs a security decision — #1312
  @desktop @ios @android @regression @fixme
  Scenario: Crypto operations blocked when locked
    Given the crypto service is locked
    When I attempt to create an auth token
    Then it should throw a CryptoException
    When I attempt to encrypt a note
    Then it should throw a CryptoException
