@backend @global-setting @sample-dataset
Feature: Sample dataset
  As someone testing a deployed instance
  I want a fixed, obviously fictional dataset I can seed and re-seed
  So that call history, shifts, contacts, cases and encrypted notes can be exercised end to end

  # These scenarios seed one fixed hub (and the five sample accounts), so they run in the
  # serial @global-setting project. The After hook removes the sample hub and accounts again.
  #
  # Seeding goes through POST /api/test-seed-sample on the secret-gated dev surface
  # (apps/worker/lib/dev-surfaces.ts), so these run against a deployed staging target as
  # well as locally. They did not until #1604: the seeding routes carried a second guard
  # pinned to ENVIRONMENT=development, because the same per-process signing seeds were also
  # handed to an unauthenticated demo login picker. That picker went with demo mode.
  #
  # Three scenarios covering POST /api/demo/reset — the demo product's admin-authenticated
  # "wipe everything and re-seed" endpoint — were REMOVED with it in #1604, not re-pointed:
  # there is no demo product, and the same effect is POST /api/test-reset followed by
  # POST /api/test-seed-sample, both already covered on the dev surface.

  Scenario: Seeding builds the fixed fictional dataset in one hub
    When the sample dataset is seeded
    Then the sample hub has 12 calls in its history
    And the sample hub has 3 shifts covering all 7 days
    And the sample volunteer is on shift now
    And the sample hub has 8 contacts
    And the sample hub has 2 cases
    And the sample hub has one conversation for each configured messaging channel
    And the sample hub audit log is a valid hash chain with entries

  Scenario: Seeding twice leaves the same row counts as seeding once
    When the sample dataset is seeded
    And the sample hub row counts are recorded
    And the sample dataset is seeded
    Then the sample hub row counts are unchanged

  Scenario: The sample volunteer decrypts their own notes
    When the sample dataset is seeded
    Then every note written by the sample volunteer decrypts to its authored text for that volunteer

  Scenario: The sample admin decrypts every note and call record
    When the sample dataset is seeded
    Then every sample note decrypts to its authored text for the sample admin
    And every sample call record decrypts for the sample admin with the fictional caller number

  Scenario: The sample volunteer only sees their own notes
    When the sample dataset is seeded
    Then the sample volunteer sees only their own notes and the sample admin sees all of them
