@android
Feature: Invite Management (Mobile)
  Admins create invite codes for new volunteers and can revoke a mistaken
  invite. Revocation must be real end-to-end (#764): the invite row is gone
  from the server, redeeming the revoked code is rejected, and the revocation
  lands in the hub audit chain — a card disappearing from the list alone
  proves nothing.

  @android @regression
  Scenario: Admin can see pending invites and revoke them
    Given I am logged in as an admin
    And I navigate to the "Volunteers" page
    When I create an invite for a new volunteer
    And I dismiss the invite link card
    Then the volunteer name should appear in the pending invites list
    When I revoke the invite
    Then the volunteer name should no longer appear in the list
