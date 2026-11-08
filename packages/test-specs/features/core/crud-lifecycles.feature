@backend
Feature: CRUD Lifecycles
  Complete create-read-update-delete cycles for each entity type.
  Verifies that all CRUD operations work correctly end-to-end.

  # ─── Volunteers ────────────────────────────────────────────────────

  Scenario: Full volunteer lifecycle
    When an admin creates a volunteer named "CRUD Alice"
    Then the volunteer list should contain "CRUD Alice"
    When the admin updates the volunteer name to "CRUD Alice Updated"
    Then the volunteer list should contain "CRUD Alice Updated"
    When the admin deactivates the volunteer
    Then the volunteer should be inactive

  Scenario: Volunteer role assignment
    When an admin creates a volunteer with role "role-reviewer"
    Then the volunteer's role list should include "role-reviewer"
    When the admin changes the volunteer's role to "role-hub-admin"
    Then the volunteer's role list should include "role-hub-admin"
    And the volunteer's role list should not include "role-reviewer"

  # ─── Shifts ────────────────────────────────────────────────────────

  Scenario: Full shift lifecycle
    When an admin creates a shift named "CRUD Morning"
    Then the shift list should contain "CRUD Morning"
    When the admin updates the shift name to "CRUD Morning Updated"
    Then the shift list should contain "CRUD Morning Updated"
    When the admin deletes the shift
    Then the shift list should not contain "CRUD Morning Updated"

  Scenario: Shift with volunteer assignment
    Given a test volunteer for shift assignment
    When an admin creates a shift with the volunteer assigned
    Then the shift should include the volunteer in its roster

  # ─── Bans ──────────────────────────────────────────────────────────

  Scenario: Full ban lifecycle
    When an admin bans phone "+15550001111"
    Then the ban list should contain "+15550001111"
    When the admin removes the ban for "+15550001111"
    Then the ban list should not contain "+15550001111"

  Scenario: Lifting a ban is recorded against the ban it lifted
    When an admin bans phone "+15550001112"
    And the admin removes the ban for "+15550001112"
    And the admin removes the ban for "+15550001112" again
    Then the repeated removal is refused as not found
    And the hub audit log records exactly one unban, naming the ban on "+15550001112"

  Scenario: Shift override changes are recorded in the hub audit log
    When an admin creates a cancel override for "2026-07-04"
    And the admin deletes that override
    Then the hub audit log records "shiftOverrideCreated" for the override on "2026-07-04"
    And the hub audit log records "shiftOverrideDeleted" for the override on "2026-07-04"

  Scenario: Bulk ban import
    When an admin bulk imports bans for 3 phone numbers
    Then the ban list should contain all 3 numbers
    And the bulk import should report 3 created

  # ─── Notes ─────────────────────────────────────────────────────────

  Scenario: Full note lifecycle
    When an admin creates a note with encrypted content
    Then the note should appear in the notes list
    When the admin updates the note content
    Then the note should have updated content

  Scenario: Note with reply
    Given a note exists
    When an admin creates a reply on the note
    Then the note should have 1 reply

  Scenario: Notes list with filters
    Given 3 notes exist for different calls
    When the admin lists notes for the first call
    Then only notes for that call should be returned

  # ─── Invites ───────────────────────────────────────────────────────

  Scenario: Full invite lifecycle
    When an admin creates an invite for "CRUD Invitee"
    Then the invite list should contain "CRUD Invitee"
    When the admin revokes the invite
    Then the invite list should not contain the revoked code

  # ─── Roles ─────────────────────────────────────────────────────────

  Scenario: Custom role lifecycle
    When an admin creates a custom role "CRUD Analyst" with permissions "notes:read-own,audit:read"
    Then the roles list should contain "CRUD Analyst"
    When the admin updates the role permissions to "notes:read-own,audit:read,bans:read"
    Then the role should have 3 permissions
    When the admin deletes the custom role
    Then the roles list should not contain "CRUD Analyst"

  Scenario: System role cannot be deleted
    When an admin attempts to delete the system "role-super-admin" role
    Then the response should indicate the role is protected

  # ─── Custom Fields ────────────────────────────────────────────────

  Scenario: Custom fields lifecycle
    When an admin sets custom fields with a "disposition" text field
    Then the custom fields should include "disposition"
    When the admin updates custom fields adding a "severity" select field
    Then the custom fields should include both "disposition" and "severity"
    When the admin removes all custom fields
    Then the custom fields list should be empty

  # ─── Reports ───────────────────────────────────────────────────────

  Scenario: Report lifecycle
    Given a reporter user exists
    When the reporter creates a report titled "CRUD Test Report"
    Then the report should appear in the reports list
    When an admin assigns the report to a reviewer
    And the admin updates the report status to "closed"
    Then the report status should be "closed"

  # ─── Fallback Group ────────────────────────────────────────────────

  Scenario: Fallback group management
    Given 2 volunteers exist
    When an admin sets the fallback group to those volunteers
    Then the fallback group should contain both volunteers
    When the admin clears the fallback group
    Then the fallback group should be empty

  # ─── Audit Trail Verification ──────────────────────────────────────

  Scenario: CRUD operations generate audit entries
    When an admin creates a volunteer named "CRUD Audit Test"
    Then the audit log should contain a "userAdded" entry
    When the admin deactivates the volunteer
    Then the audit log should contain a "userDeactivated" entry

  # ─── Spam Settings ────────────────────────────────────────────────

  Scenario: Spam settings round-trip
    When an admin updates spam settings with captcha enabled
    Then spam settings should show captcha enabled
    When the admin updates spam settings with captcha disabled
    Then spam settings should show captcha disabled
