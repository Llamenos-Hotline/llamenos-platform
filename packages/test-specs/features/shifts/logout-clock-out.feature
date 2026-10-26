@backend
Feature: Logging out takes a user off shift only when no session is left to ring
  A logged-out volunteer who is still clocked in is still rung: the caller is
  routed to someone who is not there and the ring is spent (#2205). But a
  logout is per session, and a user signed in on a phone and a desktop who logs
  out of the phone must keep ringing on the desktop. So the server clocks the
  user out of every hub exactly when the logout ends their LAST live session.

  Background:
    Given a volunteer is scheduled on shift now
    And the scheduled volunteer clocks in

  Scenario: Logging out of one of two devices leaves the volunteer on shift
    Given the scheduled volunteer is signed in on 2 devices
    When the scheduled volunteer logs out of their first device
    Then the volunteer's first device session is revoked
    And the volunteer's second device session is still valid
    And the scheduled volunteer is still clocked in on the hub
    And the scheduled volunteer is a ring target

  Scenario: Logging out of the only device takes the volunteer off shift
    Given the scheduled volunteer is signed in on 1 device
    When the scheduled volunteer logs out of their first device
    Then the volunteer's first device session is revoked
    And the scheduled volunteer is no longer clocked in on the hub
    And the scheduled volunteer is not a ring target

  Scenario: A signed logout with no session at all takes the volunteer off shift
    When the scheduled volunteer logs out with a signed request
    Then the scheduled volunteer is no longer clocked in on the hub
    And the scheduled volunteer is not a ring target

  Scenario: Logging out never revokes the signing key
    Given the scheduled volunteer is signed in on 1 device
    When the scheduled volunteer logs out of their first device
    Then the volunteer's signing key still authenticates
