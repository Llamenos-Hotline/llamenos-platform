@backend @security
Feature: Invite Lifecycle
  As an admin
  I want to create, validate, and redeem invite codes
  So that only authorized people can join the system

  @backend
  Scenario: Admin creates an invite
    Given I am logged in as an admin
    When the admin creates an invite for "New Volunteer" with phone "+15551234567"
    Then the response status is 201
    And the invite has a valid UUID code
    And the invite has an expiration date

  @backend
  Scenario: Validate a valid invite code
    Given I am logged in as an admin
    And an invite exists for "Val Test" with phone "+15551234568"
    When the invite code is validated
    Then the response status is 200
    And the invite is valid

  @backend
  Scenario: Validate a nonexistent invite code
    When a random UUID is validated as an invite
    Then the response status is 200
    And the invite is not valid with error "not_found"

  @backend
  Scenario: Redeem an invite to register a new user
    Given I am logged in as an admin
    And an invite exists for "Redeemer" with phone "+15551234569"
    When a new user redeems the invite
    Then the response status is 200

  @backend
  Scenario: Redeemed invite cannot be reused
    Given I am logged in as an admin
    And an invite exists for "Single Use" with phone "+15551234570"
    And the invite has been redeemed by a user
    When the invite code is validated
    Then the invite is not valid with error "already_used"

  @backend
  Scenario: Redeeming an invite makes the volunteer a member of the hub it named
    # Without the membership grant the volunteer is invisible to the operator:
    # not in the hub user list, so not selectable for a shift or a ring group,
    # so never rung. #1037.
    Given I am logged in as an admin
    And an invite exists for "Hub Member" with phone "+15551234590"
    And the invite has been redeemed by a user
    Then the redeemed user is a member of the hub

  @backend
  Scenario: An existing user redeeming a second invite is admitted, not rejected
    # Being invited again is not an error — the grant merges into the user's
    # existing hub roles. It used to answer 409 and admit nobody.
    Given I am logged in as an admin
    And an invite exists for "First Invite" with phone "+15551234580"
    And the invite has been redeemed by a user
    And an invite exists for "Second Invite" with phone "+15551234581"
    When the same user redeems the invite
    Then the response status is 200
    And the redeemed user is a member of the hub
    When the invite code is validated
    Then the invite is not valid with error "already_used"

  @backend
  Scenario: Admin can list invites
    Given I am logged in as an admin
    And an invite exists for "List Test" with phone "+15551234571"
    When the admin lists invites
    Then the response status is 200
    And the invite list is not empty

  @backend
  Scenario: Admin can revoke an invite
    Given I am logged in as an admin
    And an invite exists for "Revoke Test" with phone "+15551234572"
    When the admin revokes the invite
    Then the response status is 200
    And the invite code is no longer valid

  @backend
  Scenario: Invite validation is rate limited
    When a client floods invite validation 10 times
    Then at least one response is 429

  @backend
  Scenario: Volunteer cannot create invites
    Given a registered volunteer user
    When the volunteer tries to create an invite
    Then the response status is 403
