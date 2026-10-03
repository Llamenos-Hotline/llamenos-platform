@backend @storage
Feature: Storage Integrity
  As the data persistence layer
  I want JSONB fields to be stored and retrieved with full fidelity
  So that no double-serialization bugs corrupt structured data

  Scenario Outline: JSONB round-trip for <entityType>
    Given a "<entityType>" entity is created via the API with structured JSONB data
    When the "<entityType>" is fetched via the API
    Then the API response <jsonbField> should be a proper <expectedType>
    When the "<entityType>" row is fetched directly from the database
    Then the DB <dbColumn> should have jsonb_typeof equal to "<pgType>"
    And the DB <dbColumn> should not be double-serialized

    Examples:
      | entityType                  | jsonbField       | expectedType | dbColumn          | pgType |
      | note adminEnvelopes         | adminEnvelopes   | array        | admin_envelopes   | array  |
      | note authorEnvelope         | authorEnvelope   | object       | author_envelope   | object |
      | record blindIndexes         | blindIndexes     | object       | blind_indexes     | object |
      | record summaryEnvelopes     | summaryEnvelopes | array        | summary_envelopes | array  |
      | conversation metadata       | metadata         | object       | metadata          | object |

  Scenario Outline: Settings JSONB round-trip for <settingsType>
    Given the "<settingsType>" settings are updated via the API with structured data
    When the settings are fetched via the API
    Then the API response <jsonbField> should be a proper object
    When the system_settings row is fetched directly from the database
    Then the DB <dbColumn> should have jsonb_typeof equal to "object"
    And the DB <dbColumn> should not be double-serialized

    Examples:
      | settingsType | jsonbField       | dbColumn          |
      | spam         | spamSettings     | spam_settings     |
      | call         | callSettings     | call_settings     |
      | messaging    | messagingConfig  | messaging_config  |

  Scenario: Encrypted envelope fields are byte-accurate through storage
    Given a registered volunteer "EnvelopeVol" with a known keypair
    And the admin keypair is known for envelope verification
    When the volunteer creates a note with real HPKE envelopes
    And the note is fetched via the API
    Then the API envelope ct should match the submitted ct exactly
    And the API envelope enc should match the submitted enc exactly
    When the envelope note row is fetched directly from the database
    Then the DB admin_envelopes ct should match the submitted ct exactly
    And the DB admin_envelopes enc should match the submitted enc exactly
