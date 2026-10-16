@backend @security
Feature: Hub membership is the isolation boundary
  Hub membership decides what a person can see and do in a hub. A role held
  anywhere else — in another hub, or as a global role that is not
  super-admin — grants nothing inside a hub the person does not belong to.

  Regression coverage for #1044 (a hub admin could list every user on the
  server, with phone numbers) and #1037 (invites granted a global role, so an
  invited volunteer could act in every hub and removal did not revoke access).

  Background:
    Given hub "A" and hub "B" exist
    And "Vera" is a volunteer invited to and registered in hub "A"
    And "Hugo" is an admin of hub "B" only

  Scenario: A hub admin's user list contains only that hub's members
    When "Hugo" lists the members of hub "B"
    Then the response status should be 200
    And the user list does not include "Vera"
    And no listed user carries a role assignment for hub "A"

  Scenario: A hub admin cannot fetch another hub's member by pubkey
    When "Hugo" fetches "Vera" through hub "B"
    Then the response status should be 404


  Scenario: An invite admits the invitee to its own hub only
    Then "Vera" holds a role assignment for hub "A" only
    And "Vera" can list the notes of hub "A"
    And "Vera" is refused the notes, active calls, conversations and records of hub "B"

  Scenario: Removing a volunteer from a hub revokes their access to it
    Given "Vera" can list the notes of hub "A"
    When the admin removes "Vera" from hub "A"
    Then "Vera" is refused the notes, active calls, conversations and records of hub "A"

  Scenario: A global role that is not super-admin grants nothing inside a hub
    Given "Gloria" holds the global hub-admin role and no hub membership
    Then "Gloria" is refused the users of hub "A"
    And "Gloria" is refused the notes, active calls, conversations and records of hub "A"
    And "Gloria" cannot add herself to hub "A"

  Scenario: Invites that grant hub roles cannot be issued outside a hub
    When the admin creates a volunteer invite without a hub
    Then the response status should be 400
