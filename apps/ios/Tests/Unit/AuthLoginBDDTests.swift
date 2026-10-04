import XCTest
@testable import Llamenos

/// BDD-aligned tests for `packages/test-specs/features/core/auth-login.feature`.
///
/// Each `func test…` in this file is named for exactly one Gherkin scenario in that
/// feature file, using the canonical mapping applied by
/// `packages/test-specs/tools/validate-coverage.ts`:
///
///     "Fifth wrong PIN triggers 30-second lockout"
///       → testFifthWrongPinTriggers30secondLockout
///
/// That 1:1 naming is what makes iOS coverage measurable. Do not rename a test here
/// without renaming its scenario (and the acceptance criterion behind it) — the
/// scenario is the spec, this file is the implementation.
///
/// Scope: the scenarios whose behaviour lives in `PINViewModel` / `AuthService` /
/// `CryptoService` and can therefore be asserted deterministically, without a
/// simulator UI flow. The feature's screen-level scenarios (onboarding, invite
/// redemption, backspace/PIN-dot rendering) have no scenario-named iOS test yet —
/// `bun run test-specs:validate --platform ios` lists them as MISSING.
///
/// These exercise the escalating PIN lockout ladder (H7), which is the control that
/// protects a seized volunteer device: 1–4 free retries, 30s at 5, 2min at 7,
/// 10min at 9, full key wipe at 10.
final class AuthLoginBDDTests: XCTestCase {

    private var crypto: CryptoService!
    private var keychain: KeychainService!
    private var auth: AuthService!

    /// The PIN used by the feature file's `Given I have a stored identity with PIN "12345678"`.
    private let storedPIN = "12345678"

    override func setUp() {
        super.setUp()
        crypto = CryptoService()
        keychain = KeychainService()
        clearIdentityState()
    }

    override func tearDown() {
        clearIdentityState()
        auth = nil
        keychain = nil
        crypto = nil
        super.tearDown()
    }

    // MARK: - Fixtures

    /// Remove every keychain artefact this suite can create, so each test starts
    /// from `Given the app is freshly installed`.
    private func clearIdentityState() {
        keychain.clearLockoutState()
        keychain.delete(key: KeychainKey.encryptedKeys)
        keychain.delete(key: KeychainKey.hubURL)
        keychain.delete(key: KeychainKey.biometricEnabled)
        keychain.delete(key: KeychainKey.deviceID)
        keychain.deleteBiometricPIN()
        crypto.lock()
    }

    /// `Given I have a stored identity with PIN "12345678"` — generates real device
    /// keys and stores them PIN-encrypted, then locks the crypto state so the next
    /// unlock is a genuine decrypt rather than a no-op.
    private func givenStoredIdentity(pin: String? = nil) throws {
        auth = AuthService(cryptoService: crypto, keychainService: keychain)
        _ = try auth.createNewIdentity(pin: pin ?? storedPIN, enableBiometric: false)
        crypto.lock()
    }

    /// `And the app is restarted` — a fresh `AuthService`/`PINViewModel` pair reading
    /// persisted keychain state, which is what a cold launch does.
    private func makeUnlockViewModel(
        onSuccess: @escaping () -> Void = {}
    ) -> PINViewModel {
        auth = AuthService(cryptoService: crypto, keychainService: keychain)
        return PINViewModel(
            mode: .unlock,
            authService: auth,
            keychainService: keychain,
            onSuccess: onSuccess
        )
    }

    /// A PIN that is well-formed (8 digits) but is not the stored one.
    private func wrongPIN(_ digit: Character) -> String {
        String(repeating: digit, count: 6) + "00"
    }

    /// Drive `count` failed unlock attempts through the view model, clearing any
    /// lockout window between them so the attempt counter — not the clock — is what
    /// advances. Mirrors `And I have N failed PIN attempts`.
    private func failAttempts(_ count: Int, on viewModel: PINViewModel) {
        for i in 0..<count {
            keychain.setLockoutUntil(.distantPast)
            viewModel.onPINComplete(wrongPIN(Character("\(i % 10)")))
        }
    }

    // MARK: - PIN Unlock

    /// Scenario: Correct PIN unlocks the app
    func testCorrectPinUnlocksTheApp() throws {
        try givenStoredIdentity()

        var unlocked = false
        let viewModel = makeUnlockViewModel { unlocked = true }

        viewModel.onPINComplete(storedPIN)

        XCTAssertTrue(unlocked, "Correct PIN should invoke the success handler")
        XCTAssertTrue(crypto.isUnlocked, "Crypto service should be unlocked after a correct PIN")
        XCTAssertNil(viewModel.errorMessage, "Correct PIN should not surface an error")
    }

    /// Scenario: Wrong PIN shows error on unlock
    func testWrongPinShowsErrorOnUnlock() throws {
        try givenStoredIdentity()

        var unlocked = false
        let viewModel = makeUnlockViewModel { unlocked = true }

        viewModel.onPINComplete(wrongPIN("9"))

        XCTAssertFalse(unlocked, "Wrong PIN must not unlock the app")
        XCTAssertNotNil(viewModel.errorMessage, "Wrong PIN should surface an error message")
        XCTAssertEqual(viewModel.pin, "", "PIN dots should be cleared after a wrong PIN")
        XCTAssertFalse(crypto.isUnlocked, "Crypto service must stay locked after a wrong PIN")
    }

    /// Scenario: Multiple wrong PINs allow retry
    func testMultipleWrongPinsAllowRetry() throws {
        try givenStoredIdentity()

        var unlocked = false
        let viewModel = makeUnlockViewModel { unlocked = true }

        viewModel.onPINComplete(wrongPIN("0"))
        XCTAssertNotNil(viewModel.errorMessage, "First wrong PIN should show an error")

        viewModel.onPINComplete(wrongPIN("1"))
        XCTAssertNotNil(viewModel.errorMessage, "Second wrong PIN should show an error")

        viewModel.onPINComplete(storedPIN)

        XCTAssertTrue(unlocked, "A correct PIN after two failures should still unlock")
        XCTAssertTrue(crypto.isUnlocked, "Crypto service should be unlocked after the correct PIN")
    }

    /// Scenario: PIN is encrypted and stored
    func testPinIsEncryptedAndStored() throws {
        try givenStoredIdentity()

        let stored = try keychain.retrieve(key: KeychainKey.encryptedKeys)
        XCTAssertNotNil(stored, "Encrypted key data should be stored in the keychain")

        let encrypted = try JSONDecoder().decode(EncryptedDeviceKeys.self, from: XCTUnwrap(stored))
        XCTAssertFalse(
            encrypted.state.signingPubkeyHex.isEmpty,
            "Signing pubkey should be stored for locked-state display"
        )
        XCTAssertFalse(
            encrypted.state.encryptionPubkeyHex.isEmpty,
            "Encryption pubkey should be stored for locked-state display"
        )

        let blob = try XCTUnwrap(String(data: XCTUnwrap(stored), encoding: .utf8))
        XCTAssertFalse(
            blob.contains(storedPIN),
            "The PIN itself must never be persisted alongside the encrypted keys"
        )
    }

    // MARK: - PIN Lockout Ladder (H7)

    /// Scenario: First four wrong PINs allow immediate retry
    func testFirstFourWrongPinsAllowImmediateRetry() throws {
        try givenStoredIdentity()
        let viewModel = makeUnlockViewModel()

        for attempt in 1...4 {
            viewModel.onPINComplete(wrongPIN(Character("\(attempt)")))

            XCTAssertNotNil(
                viewModel.errorMessage,
                "Attempt \(attempt) should show a PIN error message"
            )
            XCTAssertFalse(
                viewModel.isLockedOut,
                "Attempt \(attempt) must not trigger a lockout — the first four retries are free"
            )
            XCTAssertEqual(
                viewModel.failedAttempts, attempt,
                "Failed attempt counter should track attempt \(attempt)"
            )
        }
    }

    /// Scenario: Fifth wrong PIN triggers 30-second lockout
    func testFifthWrongPinTriggers30secondLockout() throws {
        try givenStoredIdentity()
        let viewModel = makeUnlockViewModel()

        failAttempts(4, on: viewModel)
        XCTAssertFalse(viewModel.isLockedOut, "Four failures should not lock the user out")

        viewModel.onPINComplete(wrongPIN("5"))

        XCTAssertEqual(viewModel.failedAttempts, 5)
        XCTAssertTrue(viewModel.isLockedOut, "The fifth failure should lock the PIN pad")
        assertLockout(viewModel, approximately: 30, tolerance: 5)
    }

    /// Scenario: Seventh wrong PIN triggers 2-minute lockout
    func testSeventhWrongPinTriggers2minuteLockout() throws {
        try givenStoredIdentity()
        let viewModel = makeUnlockViewModel()

        failAttempts(6, on: viewModel)
        keychain.setLockoutUntil(.distantPast)

        viewModel.onPINComplete(wrongPIN("7"))

        XCTAssertEqual(viewModel.failedAttempts, 7)
        XCTAssertTrue(viewModel.isLockedOut, "The seventh failure should lock the PIN pad")
        assertLockout(viewModel, approximately: 120, tolerance: 5)
    }

    /// Scenario: Ninth wrong PIN triggers 10-minute lockout
    func testNinthWrongPinTriggers10minuteLockout() throws {
        try givenStoredIdentity()
        let viewModel = makeUnlockViewModel()

        failAttempts(8, on: viewModel)
        keychain.setLockoutUntil(.distantPast)

        viewModel.onPINComplete(wrongPIN("9"))

        XCTAssertEqual(viewModel.failedAttempts, 9)
        XCTAssertTrue(viewModel.isLockedOut, "The ninth failure should lock the PIN pad")
        assertLockout(viewModel, approximately: 600, tolerance: 10)
    }

    /// Scenario: Tenth wrong PIN wipes all keys
    ///
    /// This is the terminal branch of the ladder — a seized device must not retain
    /// decryptable volunteer keys after ten failed guesses.
    func testTenthWrongPinWipesAllKeys() throws {
        try givenStoredIdentity()
        let viewModel = makeUnlockViewModel()

        failAttempts(9, on: viewModel)
        keychain.setLockoutUntil(.distantPast)
        XCTAssertEqual(
            keychain.getLockoutAttempts(), 9,
            "Nine failed attempts must be persisted going into the tenth, terminal attempt — "
                + "this is what proves the wipe below is triggered by reaching 10, not by some "
                + "other path"
        )
        XCTAssertNotNil(
            try keychain.retrieve(key: KeychainKey.encryptedKeys),
            "Keys should still be present before the tenth attempt"
        )

        viewModel.onPINComplete(wrongPIN("0"))

        // The wipe (AuthService.logout()) clears the persisted lockout counter along
        // with the keys — deliberately, not incidentally. If it didn't, a device wiped
        // this way and then re-provisioned with a brand new identity would inherit an
        // already-maxed-out counter and get its NEW identity wiped on the very first
        // wrong guess, destroying the 1-4-free-retries ladder for that identity.
        // `failedAttempts` is a live read of that same Keychain record (see the #621
        // live-read fix — caching it would silently miss exactly this kind of write
        // from another code path), so it correctly reports 0 once `logout()` has run.
        // The boundary itself — that attempt 10 is what triggers the wipe, no earlier
        // and no later — is covered independently and precisely by
        // `SecurityHardeningTests.testWipeOnTenthAttempt`/`testNoWipeBelowTenAttempts`,
        // which assert `PINLockout.shouldWipeKeys(forAttempts:)` directly against the
        // pure threshold function, decoupled from Keychain-clearing side effects.
        XCTAssertEqual(
            viewModel.failedAttempts, 0,
            "The wipe must clear the persisted attempt counter along with the keys, so a "
                + "freshly re-provisioned identity does not inherit a maxed-out lockout ladder"
        )
        XCTAssertNil(
            try keychain.retrieve(key: KeychainKey.encryptedKeys),
            "The tenth failed attempt must wipe the stored encrypted keys"
        )
        XCTAssertNil(
            try keychain.retrieveString(key: KeychainKey.hubURL),
            "The wipe should also clear the stored hub URL"
        )
        XCTAssertFalse(crypto.isUnlocked, "Crypto state must be locked after a wipe")
    }

    /// Scenario: Correct PIN resets attempt counter
    func testCorrectPinResetsAttemptCounter() throws {
        try givenStoredIdentity()

        var unlocked = false
        let viewModel = makeUnlockViewModel { unlocked = true }

        failAttempts(3, on: viewModel)
        XCTAssertEqual(viewModel.failedAttempts, 3, "Three failures should be recorded")
        keychain.setLockoutUntil(.distantPast)

        viewModel.onPINComplete(storedPIN)

        XCTAssertTrue(unlocked, "The correct PIN should unlock after three failures")
        XCTAssertEqual(viewModel.failedAttempts, 0, "A correct PIN should reset the counter")
        XCTAssertEqual(
            keychain.getLockoutAttempts(), 0,
            "The persisted attempt counter should also be reset"
        )
    }

    /// Scenario: Lockout persists after app restart
    ///
    /// The lockout lives in the Keychain, not in memory, so force-quitting the app
    /// is not a way to skip the penalty.
    func testLockoutPersistsAfterAppRestart() throws {
        try givenStoredIdentity()
        let viewModel = makeUnlockViewModel()

        failAttempts(4, on: viewModel)
        keychain.setLockoutUntil(.distantPast)
        viewModel.onPINComplete(wrongPIN("5"))

        XCTAssertTrue(viewModel.isLockedOut, "Five failures should lock the user out")

        // "When the app is restarted" — a fresh view model reading persisted state.
        let afterRestart = makeUnlockViewModel()

        XCTAssertEqual(
            afterRestart.failedAttempts, 5,
            "The failed attempt count should survive a restart"
        )
        XCTAssertTrue(
            afterRestart.isLockedOut,
            "The lockout should still be in force after a restart"
        )

        var unlockedWhileLockedOut = false
        let lockedOutViewModel = makeUnlockViewModel { unlockedWhileLockedOut = true }
        lockedOutViewModel.onPINComplete(storedPIN)
        XCTAssertFalse(
            unlockedWhileLockedOut,
            "Even the correct PIN must be refused while the lockout is active"
        )
    }

    /// Scenario: After lockout expires, retry is allowed
    func testAfterLockoutExpiresRetryIsAllowed() throws {
        try givenStoredIdentity()
        let viewModel = makeUnlockViewModel()

        failAttempts(4, on: viewModel)
        keychain.setLockoutUntil(.distantPast)
        viewModel.onPINComplete(wrongPIN("5"))
        XCTAssertTrue(viewModel.isLockedOut, "Five failures should lock the user out")

        // "And the lockout has expired" — wind the persisted expiry into the past
        // rather than sleeping through a real 30-second window.
        keychain.setLockoutUntil(Date().addingTimeInterval(-1))

        var unlocked = false
        let afterExpiry = makeUnlockViewModel { unlocked = true }
        XCTAssertFalse(afterExpiry.isLockedOut, "An expired lockout should no longer block entry")

        afterExpiry.onPINComplete(storedPIN)

        XCTAssertTrue(unlocked, "The correct PIN should unlock once the lockout has expired")
        XCTAssertTrue(crypto.isUnlocked, "Crypto service should be unlocked")
    }

    // MARK: - Access Control

    /// Scenario: Crypto operations blocked when locked
    func testCryptoOperationsBlockedWhenLocked() throws {
        try givenStoredIdentity()
        crypto.lock()
        XCTAssertFalse(crypto.isUnlocked, "Given the crypto service is locked")

        XCTAssertThrowsError(
            try crypto.createAuthToken(method: "GET", path: "/api/notes"),
            "Creating an auth token while locked must throw"
        ) { error in
            XCTAssertEqual(
                error as? CryptoServiceError, .noKeyLoaded,
                "Auth token creation should fail with noKeyLoaded while locked"
            )
        }

        XCTAssertThrowsError(
            try crypto.encryptNote(payload: "locked", recipientPubkeys: []),
            "Encrypting a note while locked must throw"
        ) { error in
            XCTAssertEqual(
                error as? CryptoServiceError, .noKeyLoaded,
                "Note encryption should fail with noKeyLoaded while locked"
            )
        }
    }

    // MARK: - Device Key Validation

    /// Scenario: Login rejects key without valid prefix
    func testLoginRejectsKeyWithoutValidPrefix() {
        auth = AuthService(cryptoService: crypto, keychainService: keychain)

        XCTAssertThrowsError(
            try auth.validatePIN("npub"),
            "A credential without a valid prefix and under the minimum length must be rejected"
        )
        XCTAssertThrowsError(
            try auth.validatePIN("!!!!!!!!"),
            "A credential that is neither numeric nor alphanumeric must be rejected"
        )
    }

    /// Scenario: Login rejects very short device key
    func testLoginRejectsVeryShortDeviceKey() {
        auth = AuthService(cryptoService: crypto, keychainService: keychain)

        XCTAssertThrowsError(try auth.validatePIN("1234567"), "7 digits is below the 8 minimum") { error in
            XCTAssertEqual(error as? AuthError, .credentialTooShort)
        }
        XCTAssertThrowsError(try auth.validatePIN(""), "An empty credential must be rejected") { error in
            XCTAssertEqual(error as? AuthError, .credentialTooShort)
        }
        XCTAssertNoThrow(try auth.validatePIN("12345678"), "8 digits is the accepted minimum")
    }

    // MARK: - Helpers

    /// Assert the active lockout window is roughly `seconds` long.
    private func assertLockout(
        _ viewModel: PINViewModel,
        approximately seconds: TimeInterval,
        tolerance: TimeInterval,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let remaining = viewModel.lockoutUntil.timeIntervalSinceNow
        XCTAssertEqual(
            remaining, seconds, accuracy: tolerance,
            "Lockout should be approximately \(Int(seconds)) seconds, got \(Int(remaining))",
            file: file, line: line
        )
        XCTAssertNotNil(viewModel.errorMessage, "A lockout should surface a message", file: file, line: line)
    }
}
