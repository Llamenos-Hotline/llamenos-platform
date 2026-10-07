@backend
Feature: Edge Cases and Error Handling
  Verify pagination boundaries, error response consistency,
  concurrent operations, and input boundary values.

  # ─── Pagination ────────────────────────────────────────────────────

  Scenario: Empty list returns zero total
    When an admin lists notes
    Then the notes list should be empty with total 0

  Scenario: Pagination returns correct subset
    Given 15 notes exist in the system
    When an admin lists notes with page 1 limit 10
    Then 10 notes should be returned with total 15
    When an admin lists notes with page 2 limit 10
    Then 5 notes should be returned with total 15

  Scenario: Page beyond data returns empty
    Given 5 notes exist in the system
    When an admin lists notes with page 100 limit 10
    Then the notes list should be empty

  Scenario: Shift list returns correct count
    Given 3 shifts exist
    When an admin lists shifts
    Then 3 shifts should be returned

  Scenario: Ban list returns correct count
    Given 5 bans exist
    When an admin lists bans
    Then 5 bans should be returned

  # ─── Duplicate Prevention ──────────────────────────────────────────

  Scenario: Duplicate ban phone is handled gracefully
    When an admin bans phone "+15550009999"
    And an admin bans phone "+15550009999" again
    Then the ban list should contain exactly 1 entry for "+15550009999"

  Scenario: Duplicate role slug is rejected
    When an admin creates a role with slug "edge-case-role"
    And an admin creates another role with slug "edge-case-role"
    Then the second role creation should return 409

  # ─── Input Boundary Values ─────────────────────────────────────────

  Scenario: Maximum length volunteer name is accepted
    When an admin creates a volunteer with a 200-character name
    Then the volunteer should be created successfully

  Scenario: Unicode characters in volunteer name
    When an admin creates a volunteer named "Voluntario Prueba"
    Then the volunteer list should contain "Voluntario Prueba"

  Scenario: Special characters in ban reason
    When an admin creates a ban with reason "Test <script>alert(1)</script>"
    Then the ban should be created successfully

  Scenario: Empty optional fields are accepted
    When an admin creates a volunteer with no optional fields
    Then the volunteer should be created successfully

  # ─── Error Response Consistency ────────────────────────────────────

  Scenario: 404 for non-existent volunteer
    When an admin requests volunteer "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the response status should be 404

  Scenario: 404 for non-existent shift
    When an admin deletes shift "non-existent-shift-id"
    Then the response status should be 404

  Scenario: 404 for non-existent note
    When an admin requests note replies for "non-existent-note-id"
    Then the response status should be 404

  # ─── CORS Headers ──────────────────────────────────────────────────

  Scenario: OPTIONS preflight returns correct CORS headers
    When a CORS preflight request is sent to "/api/users"
    Then the response should include CORS headers

  # The scenario above only proves an allowed origin is admitted, which the
  # development escape hatch alone could satisfy. This one proves a policy
  # exists at all, and it holds in every environment (#1624).
  Scenario: OPTIONS preflight from an unlisted origin is refused
    When a CORS preflight request from an unlisted origin is sent to "/api/users"
    Then the preflight should be refused

  # ─── Rate Limiting ────────────────────────────────────────────────

  Scenario: Invite validation is rate limited
    When 10 invite validation requests are sent rapidly
    Then at least one should return 429

  # ─── Large Batch Operations ────────────────────────────────────────

  Scenario: Bulk ban with 50 phones succeeds
    When an admin bulk imports 50 banned phones
    Then the bulk import should succeed with count 50

  Scenario: Multiple shifts with same time don't conflict
    When an admin creates 3 shifts for the same time slot
    Then all 3 shifts should exist independently

  # ─── Concurrent State ─────────────────────────────────────────────

  Scenario: Shift and fallback group are independent
    Given a volunteer exists
    When an admin adds the volunteer to a shift
    And the admin adds the volunteer to the fallback group
    Then the volunteer appears in both the shift and fallback group
    When the admin removes the volunteer from the shift
    Then the volunteer still appears in the fallback group
