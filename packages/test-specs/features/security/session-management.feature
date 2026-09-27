@backend @desktop @ios @android @security
Feature: Session Management
  As the authentication system
  I want to manage session lifecycle securely
  So that unauthorized access is prevented

  @backend
  Scenario: WebAuthn session token has correct TTL
    Given a user with a registered WebAuthn credential
    When a new session token is issued
    Then the token should expire within 24 hours

  @backend
  Scenario: Expired session token is rejected
    Given a user with a valid session token
    When the token has expired
    And the user presents the expired token
    Then the server should reject with 401

  @backend
  Scenario: Session token sliding renewal extends TTL
    Given a user with a valid session token
    When the user makes an authenticated request
    Then the session TTL should be extended

  @backend
  Scenario: Session revocation on role change
    Given a volunteer with an active session
    When an admin changes the volunteer's role
    Then the volunteer's existing session should be invalidated
    And the volunteer must re-authenticate

  @backend
  Scenario: Session revocation on volunteer deactivation
    Given a volunteer with an active session
    When the volunteer is deactivated by an admin
    Then the volunteer's session tokens should be invalidated

  @backend
  Scenario: Multiple concurrent sessions are supported
    Given a user authenticated on two devices
    When both devices make requests simultaneously
    Then both sessions should be valid

  @backend
  Scenario: Logout invalidates only the current session
    Given a user authenticated on two devices
    When the user logs out on device 1
    Then device 1's session should be invalid
    And device 2's session should still be valid

  @backend
  Scenario: List active sessions via API
    Given a registered user with a known keypair
    When the user lists their sessions
    Then the response status is 200
    And the session list is returned

  @backend
  Scenario: Terminate all other sessions via API
    Given a registered user with a known keypair
    When the user terminates all other sessions
    Then the response status is 200
    And the terminated session count is returned

  @backend
  Scenario: Terminate a specific session that does not exist returns 404
    Given a registered user with a known keypair
    When the user terminates session "nonexistent-session-id"
    Then the response status is 404

  @backend
  Scenario: List security events
    Given a registered user with a known keypair
    When the user lists their security events
    Then the response status is 200
    And the security event list is returned
