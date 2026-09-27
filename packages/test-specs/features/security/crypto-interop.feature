@desktop @ios @android @crypto
Feature: Crypto Interop
  As a platform implementation
  I want to verify crypto operations against known test vectors
  So that all platforms produce compatible ciphertext

  # ── Keypair Generation ────────────────────────────────────────────

  # @wip: signing-key steps have no desktop definitions (see also #1123) — #1195
  @smoke @wip
  Scenario: Generated keypair has valid format
    When I generate a new keypair
    Then the signing key should be valid hex
    And the npub should start with "npub1"
    And the signing key should be 64 characters long
    And the npub should be 63 characters long

  # @wip: signing-key steps have no desktop definitions (see also #1123) — #1195
  @smoke @wip
  Scenario: Generated keypair is unique each time
    When I generate keypair A
    And I generate keypair B
    Then keypair A's signing key should differ from keypair B's signing key
    And keypair A's npub should differ from keypair B's npub

  Scenario: Public key is 64 hex characters
    When I generate a keypair
    Then the public key hex should be 64 characters
    And the public key should only contain hex characters [0-9a-f]

  # @wip: signing-key steps have no desktop definitions (see also #1123) — #1195
  @wip
  Scenario: Keypair import roundtrip
    When I generate a keypair and get the signing key
    And I import that signing key into a fresh CryptoService
    Then the imported pubkey should match the original pubkey
    And the imported npub should match the original npub

  # ── Test Vector Interop ───────────────────────────────────────────

  @regression
  Scenario: Key derivation matches test vectors
    Given the test-vectors.json fixture is loaded
    And the test secret key from vectors
    When I derive the public key
    Then it should match the expected public key in vectors

  @regression
  Scenario: Note encryption roundtrip
    Given the test-vectors.json fixture is loaded
    And the test keypair from vectors
    When I encrypt a note with the test payload
    And I decrypt the note with the author envelope
    Then the decrypted plaintext should match the original

  Scenario: Note decryption with wrong key fails
    Given the test-vectors.json fixture is loaded
    And a note encrypted for the test author
    When I attempt to decrypt with the wrong secret key
    Then decryption should return null

  Scenario: Message encryption multi-reader roundtrip
    Given the test-vectors.json fixture is loaded
    And the volunteer and admin keypairs from vectors
    When I encrypt a message for both readers
    Then the volunteer can decrypt the message
    And the admin can decrypt the message
    And a third party with a wrong key cannot decrypt

  # @wip: signing-key steps have no desktop definitions (see also #1123) — #1195
  @smoke @wip
  Scenario: PIN encryption matches format constraints
    Given the test-vectors.json fixture is loaded
    And the test PIN and signing key from vectors
    When I encrypt with the test PIN
    Then the salt length should be 32 hex characters
    And the nonce length should be 48 hex characters
    And the iterations should be 600,000
    And decryption with the same PIN should succeed

  @offline
  Scenario: Domain separation labels match protocol
    Given the test-vectors.json fixture is loaded
    And the label constants from vectors
    Then there should be exactly 28 label constants
    And the following labels should match:
      | constant             | expected_value              |
      | labelNoteKey         | llamenos:note-key           |
      | labelMessage         | llamenos:message            |
      | labelHubKeyWrap      | llamenos:hub-key-wrap       |
      | labelCallMeta        | llamenos:call-meta          |
      | labelFileKey         | llamenos:file-key           |
      | labelFileMetadata    | llamenos:file-metadata      |

  Scenario: Ephemeral keypair generation for device linking
    When I generate an ephemeral keypair
    Then both the secret and public key should be 64 hex characters
    And generating another keypair should produce different keys

  Scenario: SAS code derivation is deterministic
    Given a shared secret hex string
    When I derive the SAS code
    Then it should be exactly 6 digits
    And deriving again with the same secret should produce the same code
    And deriving with a different secret should produce a different code

  # ── Auth Tokens ───────────────────────────────────────────────────

  Scenario: Auth token has correct structure
    Given I have a loaded keypair with known pubkey
    When I create an auth token for "GET" "/api/notes"
    Then the token should contain the pubkey
    And the token should contain a timestamp within the last minute
    And the token signature should be 128 hex characters

  Scenario: Auth token is unique per request
    Given I have a loaded keypair
    When I create a token for "GET" "/api/notes"
    And I create another token for "POST" "/api/notes"
    Then the two tokens should have different signatures
    And the two tokens should have different timestamps (unless same millisecond)

  Scenario: Locked crypto service cannot create tokens
    Given the crypto service is locked
    When I attempt to create an auth token
    Then it should throw a CryptoException

  # ── PIN Encryption ────────────────────────────────────────────────

  @smoke
  Scenario: PIN encryption roundtrip with correct PIN
    Given I have a loaded keypair
    When I encrypt the key with PIN "123456"
    And I lock the crypto service
    And I decrypt with PIN "123456"
    Then the crypto service should be unlocked
    And the pubkey should match the original

  Scenario: PIN encryption fails with wrong PIN
    Given I have a loaded keypair
    When I encrypt the key with PIN "123456"
    And I lock the crypto service
    And I attempt to decrypt with PIN "999999"
    Then decryption should fail with "Incorrect PIN"
    And the crypto service should remain locked

  Scenario: Encrypted key data has correct structure
    Given I have a loaded keypair
    When I encrypt the key with PIN "567890"
    Then the encrypted data should have a non-empty ciphertext
    And the encrypted data should have a non-empty salt
    And the encrypted data should have a non-empty nonce
    And the encrypted data should have a pubkey matching the original
    And the iterations should be 600,000

  @regression
  Scenario Outline: PIN validation rejects invalid inputs
    Given I have a loaded keypair
    When I attempt to encrypt with PIN "<pin>"
    Then encryption should "<result>"

    Examples:
      | pin     | result           |
      | 123     | fail (too short) |
      | 1234567 | fail (too long)  |
      |         | fail (empty)     |

  # ── Wake Key Validation ───────────────────────────────────────────

  @android @ios
  Scenario: Wake key generation produces valid 64-char hex public key
    When I generate a wake key
    Then the wake public key should be 64 hex characters
    And the wake key should be stored persistently
    And generating the wake key again should return the same key

  @android @ios
  Scenario: Decryption rejects malformed ephemeral public key
    Given a wake key has been generated
    When I attempt to decrypt a wake payload with a malformed ephemeral key
    Then the decryption should return null

  @android @ios
  Scenario: Decryption rejects truncated ciphertext
    Given a wake key has been generated
    When I attempt to decrypt a wake payload with truncated ciphertext
    Then the decryption should return null
