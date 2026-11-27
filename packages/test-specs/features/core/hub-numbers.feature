@backend @hub-numbers
Feature: The numbers a hub answers on
  A self-hosted PBX has no number API: the carrier delivers the DIDs, so the
  operator tells the server which numbers belong to a hub. Inbound routing reads
  that one declaration — not a copy kept in the provider form — and a number
  belongs to at most one hub (#1331).

  Scenario: A declared number is stored in E.164 and listed with the hub
    Given a hub that answers on no number
    When the operator declares the numbers "+1 (555) 100-0101" and "+15551000102" for the hub
    Then the declaration is accepted
    And the hub lists the numbers "+15551000101" and "+15551000102", primary first
    And the hub's primary number is "+15551000101"

  Scenario: A number another hub answers on cannot be declared
    Given a hub that answers on no number
    And another hub answers on "+15551000103"
    When the operator declares the numbers "+15551000103" for the hub
    Then the declaration is refused as a conflict
    And the hub lists no numbers

  Scenario: Something that is not a telephone number is refused
    Given a hub that answers on no number
    When the operator declares the numbers "not a number" for the hub
    Then the declaration is refused as invalid
    And the hub lists no numbers

  Scenario: The provider form's number is the hub's number
    Given a hub that answers on no number
    When the operator configures the hub's PBX provider with the number "+15551000104"
    Then the hub lists the numbers "+15551000104", primary first
