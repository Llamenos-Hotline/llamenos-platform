@backend @security @audit
Feature: Audit Integrity
  As the security system
  I want audit log entries to be immutable and hash-chained
  So that tampering with the audit trail is detectable

  # ── Comprehensive Audit Capture ──────────────────────────────────

  Scenario: Audit log captures all state-changing operations
    Given an admin performs the following operations:
      | operation          | detail               |
      | create volunteer   | BDD Audit Vol        |
      | create shift       | BDD Audit Shift      |
      | create ban         | +15550001234         |
      | update volunteer   | deactivate           |
    When the admin fetches the audit log
    Then at least 4 new audit entries should exist
    And each entry should have a non-empty actor pubkey
    And each entry should have a non-empty action field
    And the entry actions should include "userAdded"
    And the entry actions should include "shiftCreated"

  # ── Hash Chain Verification ──────────────────────────────────────

  Scenario: Audit hash chain is verifiable
    And an admin performs 5 sequential operations
    When the audit log is fetched ordered by creation time
    Then each entry should have an "entryHash" field
    And for entries 1 through 4, previousEntryHash should equal the prior entry's entryHash
    And the full chain should pass database-level verification
    And the stored details of user-actor entries should be sealed at rest

  # ── API-Level Chain Verification ─────────────────────────────────

  Scenario: Verify endpoint confirms an intact chain
    Given an admin performs 5 sequential operations
    When the audit chain is verified via the API endpoint
    Then the verification result should be valid
    And the verification result should report at least 5 checked entries

  Scenario: Tampered entry is detected by the verify endpoint
    Given an admin performs 3 sequential operations
    When the audit chain is verified via the API endpoint
    Then the verification result should be valid
    When the action field of the latest audit entry is tampered in the database
    And the audit chain is verified via the API endpoint
    Then the verification result should be invalid
    And the verification result should identify the broken entry

  # ── Concurrent Appends (#1045) ───────────────────────────────────

  Scenario: Concurrent audited writes keep the hash chain linear
    Given an admin performs 20 concurrent operations
    When the audit chain is verified via the API endpoint
    Then the verification result should be valid
    And the verification result should report at least 20 checked entries
    And no two audit entries should share the same previousEntryHash

  # ── Tamper Detection ─────────────────────────────────────────────

  Scenario: Audit entries are tamper-detectable
    And an admin creates a volunteer to generate an audit entry
    When the latest audit entry is fetched
    Then recomputing the hash with computeAuditEntryHash should match the stored entryHash
    And modifying the action field should produce a different hash
    And modifying the actor pubkey should produce a different hash
