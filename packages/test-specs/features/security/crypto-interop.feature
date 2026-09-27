@crypto
Feature: Crypto Interop
  As a platform implementation
  I want every crypto assertion in this file to be checkable on the platform that runs it
  So that a green run is evidence, not decoration

  # ── Platform tagging rule for this file (read before adding a scenario) ──
  #
  # This file has two kinds of scenario and they are tagged differently on
  # purpose. Getting this wrong silently re-creates the defect in #1222.
  #
  #   @ios @android  — cross-implementation interop: these load the
  #     Rust-generated fixture `packages/crypto/tests/fixtures/test-vectors.json`
  #     and decrypt, with a real binding (UniFFI / JNI), ciphertext that the Rust
  #     crate produced. Decrypting another implementation's output is the only
  #     thing that actually catches a platform drifting.
  #     CAVEAT, do not rely on these being green: as of #1222 every step body in
  #     apps/android/.../steps/crypto/CryptoSteps.kt is wrapped in
  #     `try { ... } catch (_: Throwable) {}`, so an assertion failure there is
  #     swallowed and reported as a pass, and the `{int}` parameters above are
  #     accepted and then ignored. That is tracked separately and is NOT fixed
  #     here. Until it is, the only genuine cross-implementation coverage in the
  #     repo is `tests/crypto-interop.spec.ts`.
  #     They are NOT tagged @desktop: under Playwright the desktop
  #     webview has no Rust and no WASM — every crypto IPC call is served by the
  #     JS reimplementation in `tests/mocks/tauri-core.ts`, whose HPKE
  #     (`tests/mocks/hpke-mock.ts`) is a hand-rolled X25519+HKDF+AES-GCM
  #     construction, NOT RFC 9180. A desktop "interop" assertion would compare
  #     the mock against itself and prove nothing. The JS-vs-Rust half of interop
  #     is covered for real, in Node with the genuine RFC 9180 suite, by
  #     `tests/crypto-interop.spec.ts`.
  #
  #   @desktop  — properties of the app's own crypto path that ARE honestly
  #     checkable in the webview: envelope composition, recipient selection,
  #     content-key uniqueness, label enforcement, Argon2id key wrapping,
  #     Ed25519 auth tokens, SAS derivation. These run against the same
  #     `platform.ts` code that ships; the composition layer is unmocked
  #     WebCrypto. They make no claim about the Rust wire format.
  #
  # Do not add @desktop to a scenario that asserts a Rust-produced value.

  # ── Cross-implementation interop against Rust test vectors (mobile) ──
  #
  # Desktop equivalent: tests/crypto-interop.spec.ts (Node, real RFC 9180).
  # Rust side: packages/crypto/tests/interop.rs.

  @ios @android @regression
  Scenario: Key derivation matches test vectors
    Given the test-vectors.json fixture is loaded
    And the test secret key from vectors
    When I derive the public key
    Then it should match the expected public key in vectors

  @ios @android @regression
  Scenario: Note encryption roundtrip
    Given the test-vectors.json fixture is loaded
    And the test keypair from vectors
    When I encrypt a note with the test payload
    And I decrypt the note with the author envelope
    Then the decrypted plaintext should match the original

  @ios @android
  Scenario: Note decryption with wrong key fails
    Given the test-vectors.json fixture is loaded
    And a note encrypted for the test author
    When I attempt to decrypt with the wrong secret key
    Then decryption should return null

  @ios @android
  Scenario: Message encryption multi-reader roundtrip
    Given the test-vectors.json fixture is loaded
    And the volunteer and admin keypairs from vectors
    When I encrypt a message for both readers
    Then the volunteer can decrypt the message
    And the admin can decrypt the message
    And a third party with a wrong key cannot decrypt

  @ios @android @smoke
  Scenario: PIN encryption matches format constraints
    Given the test-vectors.json fixture is loaded
    And the test PIN and device key from vectors
    When I encrypt with the test PIN
    Then the salt length should be 64 hex characters
    And the nonce length should be 24 hex characters
    And decryption with the same PIN should succeed

  # ── Device keypair generation (desktop app crypto path) ──────────────

  @desktop @smoke
  Scenario: Generated device keypair has the v3 shape
    When I generate a device keypair
    Then the signing public key should be 64 hex characters
    And the encryption public key should be 64 hex characters
    And the signing and encryption public keys should differ

  @desktop @smoke
  Scenario: Generated device keypairs are unique each time
    When I generate device keypair A
    And I generate device keypair B
    Then device keypair A's signing public key should differ from B's
    And device keypair A's encryption public key should differ from B's

  @desktop @ios @android
  Scenario: Public key is 64 hex characters
    When I generate a keypair
    Then the public key hex should be 64 characters
    And the public key should only contain hex characters [0-9a-f]

  @desktop
  Scenario: Importing the same signing seed yields the same device identity
    When I generate a device keypair and keep its signing seed
    And I import that signing seed into a fresh device
    Then the imported signing public key should match the original
    And the imported encryption public key should match the original

  @desktop
  Scenario: Ephemeral keypair generation for device linking
    When I generate an ephemeral keypair
    Then the ephemeral public key should be 64 hex characters
    And generating another ephemeral keypair should produce a different public key

  # ── Envelope encryption via the app crypto path (desktop) ────────────

  @desktop @regression
  Scenario: Note encrypted through the app path round-trips for its author
    Given I have an unlocked device
    When I encrypt a note for the author and no admins
    And I decrypt that note with the author envelope
    Then the decrypted note should match the original payload

  @desktop @regression
  Scenario: A note carries one wrapped key per admin reader
    Given I have an unlocked device
    And two admin encryption public keys
    When I encrypt a note for the author and both admins
    Then the note should carry one admin envelope per admin
    And every admin envelope should name a distinct recipient

  @desktop @regression
  Scenario: Each note gets its own content key
    Given I have an unlocked device
    When I encrypt the same payload as two separate notes
    Then the two notes should have different ciphertext
    And the two notes should have different wrapped content keys

  @desktop @regression
  Scenario: A tampered note ciphertext does not decrypt
    Given I have an unlocked device
    When I encrypt a note for the author and no admins
    And I flip one byte of the note ciphertext
    Then decrypting the tampered note should return null

  @desktop @regression
  Scenario: A message decrypts only for a reader it was wrapped for
    Given I have an unlocked device
    When I encrypt a message for this device and one other reader
    Then this device can decrypt the message
    And a reader whose envelope is absent cannot decrypt the message

  # ── Domain separation / Albrecht defense (desktop) ───────────────────

  @desktop @offline
  Scenario: The label registry matches the protocol source of truth
    When I read the domain separation labels exposed to the client
    Then they should match the protocol crypto-labels source of truth exactly
    And no label should be the empty string
    And every label should be prefixed "llamenos:"

  @desktop @regression
  Scenario: A key wrapped under one label cannot be unwrapped under another
    Given I have an unlocked device
    When I wrap a key under the label "LABEL_NOTE_KEY"
    Then unwrapping it under the label "LABEL_NOTE_KEY" should succeed
    And unwrapping it under the label "LABEL_MESSAGE" should be rejected
    And unwrapping it under the label "LABEL_HUB_KEY_WRAP" should be rejected

  # ── SAS derivation (desktop) ─────────────────────────────────────────

  @desktop
  Scenario: SAS code derivation is deterministic
    Given a shared secret hex string
    When I derive the SAS code
    Then it should be exactly 6 digits
    And deriving again with the same secret should produce the same code
    And deriving with a different secret should produce a different code

  # ── Auth Tokens (desktop) ────────────────────────────────────────────

  @desktop @ios @android
  Scenario: Auth token has correct structure
    Given I have a loaded keypair with known pubkey
    When I create an auth token for "GET" "/api/notes"
    Then the token should contain the pubkey
    And the token should contain a timestamp within the last minute
    And the token signature should be 128 hex characters

  @desktop
  Scenario: Auth token signature is bound to the request method and path
    Given I have an unlocked device
    When I create an auth token for "GET" "/api/notes"
    And I create a second auth token for "POST" "/api/notes"
    Then the two tokens should have different signatures
    And each token signature should verify against its own request
    And neither token signature should verify against the other request

  @desktop
  Scenario: Locked crypto service cannot create tokens
    Given I have an unlocked device
    When I lock the crypto service
    And I attempt to create an auth token while locked
    Then auth token creation should have been rejected
    And the crypto service should be locked

  # ── PIN Encryption (desktop) ─────────────────────────────────────────

  @desktop @ios @android @smoke
  Scenario: PIN encryption roundtrip with correct PIN
    Given I have a loaded keypair
    When I encrypt the key with PIN "12345678"
    And I lock the crypto service
    And I decrypt with PIN "12345678"
    Then the crypto service should be unlocked
    And the pubkey should match the original

  @desktop @ios @android
  Scenario: PIN encryption fails with wrong PIN
    Given I have a loaded keypair
    When I encrypt the key with PIN "12345678"
    And I lock the crypto service
    And I attempt to decrypt with PIN "99999999"
    Then decryption should fail with "Incorrect PIN"
    And the crypto service should remain locked

  @desktop @ios @android
  Scenario: Encrypted key data has correct structure
    Given I have a loaded keypair
    When I encrypt the key with PIN "56789012"
    Then the encrypted data should have a non-empty ciphertext
    And the encrypted data should have a non-empty salt
    And the encrypted data should have a non-empty nonce
    And the encrypted data should have a pubkey matching the original

  # The KDF is Argon2id (kdfVersion 2) — see packages/crypto/src/kdf_params.rs.
  # The PBKDF2 "600,000 iterations" this file used to assert has not existed
  # since the Argon2id migration; the assertion only ever passed because the
  # step read a storage key that never resolved. Cost parameters are
  # deliberately NOT asserted by value here: the Playwright mock uses reduced
  # Argon2 costs for speed, so asserting a value would pin the test to the
  # mock's weakened parameters rather than the shipped ones.
  @desktop
  Scenario: Encrypted key data declares Argon2id parameters
    Given I have a loaded keypair
    When I encrypt the key with PIN "56789012"
    Then the encrypted data should declare KDF version 2
    And the encrypted data should carry a 32-byte salt
    And the encrypted data should carry a 12-byte nonce
    And the encrypted data should declare positive Argon2 memory, time and parallelism costs

  # NOT @desktop. The credential rule lives in Rust
  # (device_keys.rs::is_valid_credential — 8+ chars) and, for the desktop UI,
  # in src/client/lib/key-manager.ts::isValidPin, which already has direct unit
  # coverage in src/client/lib/key-manager.test.ts (too short / long enough /
  # passphrase / symbols-only / empty). The Playwright IPC mock does not
  # implement the credential check at all, so a desktop assertion here would
  # pass for every input and prove nothing. Note the corrected expectation for
  # 1234567: at 7 characters it is too SHORT — the rule is a minimum of 8, with
  # no upper bound. This file previously called it "too long".
  @ios @android @regression
  Scenario Outline: PIN validation rejects invalid inputs
    Given I have a loaded keypair
    When I attempt to encrypt with PIN "<pin>"
    Then encryption should "<result>"

    Examples:
      | pin     | result            |
      | 123     | fail (too short)  |
      | 1234567 | fail (too short)  |
      |         | fail (empty)      |

  # ── Wake Key Validation ──────────────────────────────────────────────
  #
  # Wake keys are a mobile-only capability (UniFFI / JNI). There is no
  # desktop implementation, so these are NOT tagged @desktop. They previously
  # inherited @desktop from the Feature tag and the desktop step definition
  # satisfied them by writing the literal string 'a'.repeat(64) into the page
  # and asserting it was 64 characters long — a tautology that could never
  # fail. See #1222.

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
