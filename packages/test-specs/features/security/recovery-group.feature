@backend @security @crypto
Feature: Recovery Group Lifecycle
  As the recovery system
  I want to manage hub-scoped K-of-N Shamir recovery groups
  So that users can recover encrypted data when they lose all devices

  Background:
    Given a registered admin user with "recovery:manage" permission
    And a hub is available for recovery group tests

  # -- Enrollment --

  @backend
  Scenario: Enroll a valid 2-of-3 recovery group
    When the admin enrolls a 2-of-3 recovery group for the hub
    Then the response status is 200
    And the response body has "ok" equal to true
    When the admin fetches the recovery group for the hub
    Then the response status is 200
    And the recovery group has threshold 2 and totalShares 3
    And the recovery group has 3 share holders

  @backend
  Scenario: Reject enrollment with threshold exceeding totalShares
    When the admin enrolls a recovery group with threshold 4 and totalShares 3
    Then the response status is 400
    And the response body has error containing "Threshold cannot exceed"

  @backend
  Scenario: Reject enrollment with mismatched envelope count
    When the admin enrolls a recovery group with mismatched envelope count
    Then the response status is 400
    And the response body has error containing "share envelopes"

  @backend
  Scenario: Rotate recovery group replaces old shares atomically
    Given a recovery group is enrolled for the hub
    When the admin enrolls a new 2-of-3 recovery group with different share holders
    Then the response status is 200
    When the admin fetches the recovery group for the hub
    Then the recovery group has the new share holders

  # -- Permission Enforcement --

  @backend
  Scenario: Enrollment requires recovery:manage permission
    Given a user without "recovery:manage" permission
    When that user attempts to enroll a recovery group
    Then the response status is 403

  @backend
  Scenario: Viewing group requires recovery:view permission
    Given a recovery group is enrolled for the hub
    And a user without "recovery:view" permission
    When that user fetches the recovery group for the hub
    Then the response status is 403

  # -- User Envelope --

  @backend
  Scenario: Authenticated user can store recovery envelope
    When an authenticated user stores a recovery envelope for the hub
    Then the response status is 200
    And the response body has "ok" equal to true

  @backend
  Scenario: User envelope upserts on re-submission
    When an authenticated user stores a recovery envelope for the hub
    And the user stores a different envelope for the same hub
    Then the response status is 200

  # -- Share Liveness --

  @backend
  Scenario: Share holder can submit liveness proof
    Given a recovery group is enrolled for the hub
    When a share holder submits a liveness proof for the hub
    Then the response status is 200
    And the response body has "ok" equal to true

  @backend
  Scenario: Non-holder liveness proof is rejected
    Given a recovery group is enrolled for the hub
    When a non-holder submits a liveness proof for the hub
    Then the response status is 403

  # -- Own share envelope (#2002) --
  # A holder reads their OWN envelope. The negative cases are the point: no input
  # lets a caller name another holder, and every refusal is the same 403.

  @backend
  Scenario: A share holder reads their own share envelope
    Given a recovery group is enrolled with real share holders
    When share holder 1 reads their own share envelope
    Then the response status is 200
    And the share envelope returned is share holder 1's own
    When share holder 2 reads their own share envelope
    Then the response status is 200
    And the share envelope returned is share holder 2's own

  @backend
  Scenario: A share holder cannot read another holder's share envelope by naming them
    Given a recovery group is enrolled with real share holders
    When share holder 1 reads their share envelope while naming share holder 2 as the holder
    Then the response status is 200
    And the share envelope returned is share holder 1's own
    And the response does not contain share holder 2's envelope

  @backend
  Scenario: A hub member who is not an enrolled holder is refused
    Given a recovery group is enrolled with real share holders
    When a hub member who is not a share holder reads their share envelope
    Then the response status is 403
    And the response does not contain share holder 1's envelope
    And the response does not contain share holder 2's envelope

  @backend
  Scenario: An enrolled holder without hold-share permission is refused
    Given a recovery group is enrolled with real share holders
    When an enrolled holder without hold-share permission reads their share envelope
    Then the response status is 403

  @backend
  Scenario: A holder removed from the hub can no longer read their envelope
    Given a recovery group is enrolled with real share holders
    When share holder 1 is removed from the hub
    And share holder 1 reads their own share envelope
    Then the response status is 403

  @backend
  Scenario: A share holder asking for a hub with no recovery group is refused the same way
    Given a recovery group is enrolled with real share holders
    When share holder 1 reads their own share envelope for a hub with no recovery group
    Then the response status is 403

  # -- Anti-Enumeration --

  @backend
  Scenario: Initiate for nonexistent user returns same response shape
    When an unauthenticated client initiates recovery for a nonexistent user in the hub
    Then the response status is 200
    And the response body has "verificationSent" equal to true
    And the response body has a "sessionId" UUID field

  # -- Duplicate Contribution guard (no Signal sidecar needed) --

  @backend
  Scenario: Contributing share to non-existent session returns 404
    When an authenticated user contributes a share to session "nonexistent-session-id"
    Then the response status is 404

  # -- Session listing (EP09 errata #1 / issue #729) --

  @backend
  Scenario: Admin lists recovery sessions for a hub
    Given a recovery session exists for the hub
    When the admin lists recovery sessions for the hub
    Then the response status is 200
    And the listed sessions include the seeded session

  @backend
  Scenario: Listing sessions requires recovery:view permission
    Given a recovery session exists for the hub
    And a user without "recovery:view" permission
    When that user lists recovery sessions for the hub
    Then the response status is 403

  # -- Cross-hub scoping (issue #847: recovery:view is a global permission grant
  #    and says nothing about which hub(s) the caller is actually a member of) --

  @backend
  Scenario: A recovery:view holder scoped to one hub cannot list another hub's sessions
    Given a recovery session exists for the hub
    And a second hub with a seeded recovery session
    And a user with global "recovery:view" permission who is only a member of the first hub
    When the cross-hub viewer lists recovery sessions for the second hub
    Then the response status is 403

  @backend
  Scenario: A recovery:view holder who is a member of both hubs can list sessions for either
    Given a recovery session exists for the hub
    And a second hub with a seeded recovery session
    And a user with global "recovery:view" permission who is only a member of the first hub
    And the cross-hub viewer is also added as a member of the second hub
    When the cross-hub viewer lists recovery sessions for the second hub
    Then the response status is 200
    And the listed sessions include the seeded session for the second hub
    When the cross-hub viewer lists recovery sessions for the hub
    Then the response status is 200
    And the listed sessions include the seeded session

  # -- Cross-hub scoping, round 2 (issue #847 review round 2): POST /rotate,
  #    POST /enroll, GET /:hubId, POST /session/:id/emergency, and
  #    POST /session/:id/cancel all omitted the hub-membership check present
  #    on GET /sessions — letting a holder of the GLOBAL recovery:manage /
  #    recovery:view / recovery:approve permission, scoped to only one hub,
  #    write to or read another hub's recovery group entirely. --

  @backend @crypto
  Scenario: A recovery:manage holder scoped to one hub cannot rotate another hub's recovery group
    Given a recovery group is enrolled for the hub
    And a second hub with a recovery group enrolled
    And a user with global "recovery:manage" permission who is only a member of the first hub
    When the cross-hub viewer rotates the second hub's recovery group
    Then the response status is 403

  @backend @crypto
  Scenario: A recovery:manage holder who is a member of both hubs can rotate either hub's recovery group
    Given a recovery group is enrolled for the hub
    And a second hub with a recovery group enrolled
    And a user with global "recovery:manage" permission who is only a member of the first hub
    And the cross-hub viewer is also added as a member of the second hub
    When the cross-hub viewer rotates the second hub's recovery group
    Then the response status is 200
    When the cross-hub viewer rotates the hub's recovery group
    Then the response status is 200

  @backend
  Scenario: A recovery:manage holder scoped to one hub cannot enroll a recovery group for another hub
    Given a user with global "recovery:manage" permission who is only a member of the first hub
    And a second hub with a seeded recovery session
    When the cross-hub viewer enrolls a recovery group for the second hub
    Then the response status is 403

  @backend
  Scenario: A recovery:manage holder who is a member of both hubs can enroll a recovery group for either hub
    Given a user with global "recovery:manage" permission who is only a member of the first hub
    And a second hub with a seeded recovery session
    And the cross-hub viewer is also added as a member of the second hub
    When the cross-hub viewer enrolls a recovery group for the second hub
    Then the response status is 200
    When the cross-hub viewer enrolls a recovery group for the hub
    Then the response status is 200

  @backend
  Scenario: A recovery:view holder scoped to one hub cannot fetch another hub's recovery group config
    Given a recovery group is enrolled for the hub
    And a second hub with a recovery group enrolled
    And a user with global "recovery:view" permission who is only a member of the first hub
    When the cross-hub viewer fetches the recovery group for the second hub
    Then the response status is 403

  @backend
  Scenario: A recovery:view holder who is a member of both hubs can fetch either hub's recovery group config
    Given a recovery group is enrolled for the hub
    And a second hub with a recovery group enrolled
    And a user with global "recovery:view" permission who is only a member of the first hub
    And the cross-hub viewer is also added as a member of the second hub
    When the cross-hub viewer fetches the recovery group for the second hub
    Then the response status is 200
    When the cross-hub viewer fetches the recovery group for the hub
    Then the response status is 200

  @backend
  Scenario: A recovery:approve holder scoped to one hub cannot apply emergency override to another hub's session
    Given a verified recovery session exists for the hub
    And a verified recovery session exists for the second hub
    And a user with global "recovery:approve" permission who is only a member of the first hub
    When the cross-hub viewer applies emergency override to the second hub's session
    Then the response status is 404

  @backend
  Scenario: A recovery:approve holder who is a member of both hubs can apply emergency override to either hub's session
    Given a verified recovery session exists for the hub
    And a verified recovery session exists for the second hub
    And a user with global "recovery:approve" permission who is only a member of the first hub
    And the cross-hub viewer is also added as a member of the second hub
    When the cross-hub viewer applies emergency override to the second hub's session
    Then the response status is 200
    When the cross-hub viewer applies emergency override to the hub's session
    Then the response status is 200

  @backend
  Scenario: A recovery:manage holder scoped to one hub cannot cancel another hub's recovery session
    Given a recovery session exists for the hub
    And a second hub with a seeded recovery session
    And a user with global "recovery:manage" permission who is only a member of the first hub
    When the cross-hub viewer cancels the second hub's session
    Then the response status is 404

  @backend
  Scenario: A recovery:manage holder who is a member of both hubs can cancel either hub's recovery session
    Given a recovery session exists for the hub
    And a second hub with a seeded recovery session
    And a user with global "recovery:manage" permission who is only a member of the first hub
    And the cross-hub viewer is also added as a member of the second hub
    When the cross-hub viewer cancels the second hub's session
    Then the response status is 200
    When the cross-hub viewer cancels the hub's session
    Then the response status is 200

  # -- Atomic group rotation with envelope re-wrap (EP09 errata #5 / issue #729) --

  @backend @crypto
  Scenario: Rotating a recovery group excludes the departed holder and re-wraps user envelopes
    Given a recovery group with a real HPKE keypair is enrolled for the hub
    When the admin rotates the recovery group, excluding the departed holder, and re-wraps the user envelope
    Then the response status is 200
    And the rotated recovery group excludes the departed holder
    And the departed group key cannot decrypt the rotated envelope, but the new group key can

  # -- Full recovery ceremony + recovery-device-add sigchain link (EP09 errata #12 / issue #729) --

  @backend @crypto
  Scenario: Completing recovery authorizes the new device via a self-signed sigchain link and decrypts the PUK seed
    Given a recovery group is enrolled with two real contributing holders
    When each contributing holder submits their share to the new device
    Then the recovering device reconstructs the group key from the released contributions
    When the new device completes recovery with a self-authorizing sigchain link
    Then the response status is 200
    And the recovering user's sigchain shows a recovery-device-add link signed by the new device
    And the recovered device decrypts the PUK seed envelope
