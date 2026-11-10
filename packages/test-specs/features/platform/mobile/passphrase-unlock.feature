@ios
Feature: Passphrase unlock (iOS)
  The credential that protects the device keys may be any 8+ characters —
  letters included — per the shared `is_valid_credential` rule. The unlock
  screen is a free-text SecureField, not a digit pad: a 6/8-digit pad could
  never type a longer or alphanumeric credential, which locked users out of
  identities the set screen had happily accepted (#2303).

  @regression
  Scenario: A passphrase longer than 8 characters unlocks the app
    Given I have a stored identity with passphrase "passw0rd1234"
    And the app is locked
    When I enter passphrase "passw0rd1234"
    Then I should arrive at the dashboard
