@backend @security @hub-isolation
Feature: Multi-Hub Isolation
  As a security-conscious admin
  I want complete data separation between hubs
  So that hub A admins cannot see or affect hub B data

  Background:
    Given hub "hub-a" exists with admin "admin-a"
    And hub "hub-b" exists with admin "admin-b"

  Scenario: Hub A admin cannot see Hub B provider config
    Given provider "twilio" is configured for hub "hub-a"
    When "admin-b" GETs provider status for hub "hub-b"
    Then the response does not contain hub-a config

  Scenario: Hub A provisioned number does not appear in Hub B
    Given a phone number is provisioned for hub "hub-a"
    When "admin-b" lists phone numbers for hub "hub-b"
    Then the number list does not contain hub-a number

  Scenario: Hub A channel config does not affect Hub B
    Given channel "signal" is enabled for hub "hub-a"
    When "admin-b" gets channel config for hub "hub-b"
    Then signal is not enabled for hub "hub-b"

  Scenario: Hub A usage stats do not include Hub B activity
    Given hub "hub-a" has 10 SMS sent
    And hub "hub-b" has 5 SMS sent
    When "admin-a" gets usage for hub "hub-a"
    Then the usage shows 10 SMS
    And does not show 5 SMS

  Scenario: Hub admin without manage-instance cannot create templates
    Given "admin-a" has permission "telephony:manage-providers"
    And "admin-a" does not have permission "system:manage-instance"
    When "admin-a" POSTs to create a provider template
    Then the response is 403

  Scenario: Tampered hubId in request is rejected
    Given "admin-a" is authenticated for hub "hub-a"
    When "admin-a" sends a request with hubId "hub-b" in the body
    Then the response is 403

  Scenario: Hub deactivation does not affect other hubs
    Given provider "twilio" is configured for hub "hub-a"
    And provider "twilio" is configured for hub "hub-b"
    When hub "hub-a" is deactivated
    Then provider config for hub "hub-b" still exists

  # ── Hub user directory (#1044) ────────────────────────────────────
  # Volunteer name and phone are identity-protected: a hub admin sees the
  # members of their own hub, never the volunteers of another hub.

  Scenario: Hub admin's user list contains only members of their hub
    Given "admin-a" is a hub admin of hub "hub-a"
    And user "vera" is a member of hub "hub-a" only
    And user "hugo" is a member of hub "hub-b" only
    When "admin-a" lists the users of hub "hub-a"
    Then the response is 200
    And the user list contains "vera"
    And the user list does not contain "hugo"

  Scenario: Hub admin cannot read another hub's user by pubkey
    Given "admin-a" is a hub admin of hub "hub-a"
    And user "hugo" is a member of hub "hub-b" only
    When "admin-a" gets user "hugo" through hub "hub-a"
    Then the response is 404

  Scenario: A hub member who may not read users learns nothing about another hub's user
    Given user "vera" is a member of hub "hub-a" only
    And user "hugo" is a member of hub "hub-b" only
    When "vera" gets user "hugo" through hub "hub-a"
    Then the response is 403

  Scenario: A member of several hubs shows only this hub's role assignment
    Given "admin-a" is a hub admin of hub "hub-a"
    And user "mira" is a member of hubs "hub-a" and "hub-b"
    When "admin-a" lists the users of hub "hub-a"
    Then the user list contains "mira"
    And "mira" is listed with role assignments for hub "hub-a" only

  Scenario: Hub admin cannot update or delete another hub's user
    Given "admin-a" is a hub admin of hub "hub-a"
    And user "hugo" is a member of hub "hub-b" only
    When "admin-a" renames user "hugo" through hub "hub-a"
    Then the response is 404
    When "admin-a" deletes user "hugo" through hub "hub-a"
    Then the response is 404
    And user "hugo" still exists with their original name

  Scenario: Hub admin cannot read another hub's cases through a user's case list
    Given "admin-a" is a hub admin of hub "hub-a"
    And user "hugo" is a member of hub "hub-b" only
    When "admin-a" lists the cases of user "hugo" through hub "hub-a" for hub "hub-b"
    Then the response is 404

  Scenario: A user created inside a hub is a member of that hub only
    Given "admin-a" is a hub admin of hub "hub-a"
    When "admin-a" creates user "nico" through hub "hub-a"
    Then the response is 201
    When "admin-a" lists the users of hub "hub-a"
    Then the user list contains "nico"
    When the super admin lists the users of hub "hub-b"
    Then the user list does not contain "nico"

  Scenario: Super-admin aggregate view shows operational status without credentials
    Given I am a super admin
    And provider "twilio" is configured for hub "hub-a"
    And provider "signalwire" is configured for hub "hub-b"
    When I GET provider status for all hubs
    Then I see operational status for both hubs
    And I do not see any credentials
