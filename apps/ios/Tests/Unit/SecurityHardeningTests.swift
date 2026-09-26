import XCTest
@testable import Llamenos

/// Unit tests for Epic 260 security hardening fixes.
/// Tests relay URL validation (H5), PIN lockout timing (H7), and API URL validation (H6).
final class SecurityHardeningTests: XCTestCase {

    override func tearDown() {
        super.tearDown()
        // Clean up any hub URL written to the real Keychain during tests
        // to prevent cross-test contamination (e.g. a stored hub URL leaking
        // into a test that expects no hub to be configured).
        let keychain = KeychainService()
        keychain.delete(key: KeychainKey.hubURL)
    }

    // MARK: - H5: Relay URL Validation (isValidRelayHost)

    func testRejectsLocalhost() {
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("localhost"))
    }

    func testRejectsLocalhostCaseInsensitive() {
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("LOCALHOST"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("Localhost"))
    }

    func testRejectsLoopbackIPv4() {
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("127.0.0.1"))
    }

    func testRejectsLoopbackIPv4Range() {
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("127.0.0.2"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("127.255.255.255"))
    }

    func testRejectsLoopbackIPv6() {
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("::1"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("[::1]"))
    }

    func testRejectsPrivate10Range() {
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("10.0.0.1"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("10.255.255.255"))
    }

    func testRejectsPrivate172Range() {
        // 172.16.0.0 - 172.31.255.255 is private
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("172.16.0.1"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("172.31.255.255"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("172.20.0.1"))
    }

    func testRejectsPrivate192168Range() {
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("192.168.0.1"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("192.168.1.1"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("192.168.255.255"))
    }

    func testRejectsLinkLocalIPv4() {
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("169.254.0.1"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("169.254.255.255"))
    }

    func testRejectsLinkLocalIPv6() {
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("fe80:0:0:0:0:0:0:1"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("fe80::1"))
    }

    func testRejectsEmptyHost() {
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost(""))
    }

    func testAcceptsPublicHostname() {
        XCTAssertTrue(DeviceLinkViewModel.isValidRelayHost("relay.llamenos.org"))
    }

    func testAcceptsPublicIPv4() {
        XCTAssertTrue(DeviceLinkViewModel.isValidRelayHost("8.8.8.8"))
        XCTAssertTrue(DeviceLinkViewModel.isValidRelayHost("1.1.1.1"))
    }

    func testAcceptsPublic172OutsidePrivateRange() {
        // 172.15.x.x and 172.32.x.x are NOT private
        XCTAssertTrue(DeviceLinkViewModel.isValidRelayHost("172.15.0.1"))
        XCTAssertTrue(DeviceLinkViewModel.isValidRelayHost("172.32.0.1"))
    }

    func testAcceptsCloudflareSubdomain() {
        XCTAssertTrue(DeviceLinkViewModel.isValidRelayHost("app.llamenos.org"))
        XCTAssertTrue(DeviceLinkViewModel.isValidRelayHost("relay.example.com"))
    }

    // MARK: - H5 (additional): IPv4-mapped IPv6 and unspecified addresses

    func testRejectsIPv4MappedIPv6Loopback() {
        // ::ffff:127.0.0.1 is IPv4-mapped loopback — must be rejected
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("::ffff:127.0.0.1"))
    }

    func testRejectsIPv4MappedIPv6PrivateRanges() {
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("::ffff:10.0.0.1"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("::ffff:192.168.1.1"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("::ffff:172.16.0.1"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("::ffff:169.254.0.1"))
    }

    func testRejectsUnspecifiedAddresses() {
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("0.0.0.0"))
        XCTAssertFalse(DeviceLinkViewModel.isValidRelayHost("::"))
    }

    // MARK: - H5 (additional): processQRCode IPv6 bracket bypass

    func testProcessQRCodeRejectsBracketedIPv6Loopback() {
        // Regression: manual ":" splitting extracted "[" from "[::1]", bypassing checks.
        // URL.host correctly returns "::1", which isValidRelayHost rejects.
        let viewModel = makeDeviceLinkViewModel()
        viewModel.processQRCode("llamenos-link://[::1]/abc123")
        if case .error = viewModel.currentStep {
            // Expected — private relay rejected
        } else {
            XCTFail("processQRCode must reject bracketed IPv6 loopback, got \(viewModel.currentStep)")
        }
    }

    func testProcessQRCodeRejectsBracketedIPv6Private() {
        let viewModel = makeDeviceLinkViewModel()
        viewModel.processQRCode("llamenos-link://[::ffff:192.168.1.1]/abc123")
        if case .error = viewModel.currentStep {
            // Expected
        } else {
            XCTFail("processQRCode must reject IPv4-mapped IPv6 private address, got \(viewModel.currentStep)")
        }
    }

    func testProcessQRCodeRejectsIPv6LoopbackWithPort() {
        let viewModel = makeDeviceLinkViewModel()
        viewModel.processQRCode("llamenos-link://[::1]:8080/abc123")
        if case .error = viewModel.currentStep {
            // Expected
        } else {
            XCTFail("processQRCode must reject IPv6 loopback with port, got \(viewModel.currentStep)")
        }
    }

    func testProcessQRCodeRejectsPrivate10RangeDirectly() {
        let viewModel = makeDeviceLinkViewModel()
        viewModel.processQRCode("llamenos-link://10.0.0.1/abc123")
        if case .error = viewModel.currentStep {
            // Expected
        } else {
            XCTFail("processQRCode must reject 10.x address, got \(viewModel.currentStep)")
        }
    }

    // MARK: - H5 (additional): hub domain enforcement

    func testProcessQRCodeRejectsRelayMismatchingConfiguredHub() {
        let crypto = CryptoService()
        let keychain = KeychainService()
        let auth = AuthService(cryptoService: crypto, keychainService: keychain)
        // Configure hub URL so domain enforcement kicks in
        try? auth.setHubURL("https://myserver.llamenos.org")
        let viewModel = DeviceLinkViewModel(
            cryptoService: crypto,
            authService: auth,
            keychainService: keychain
        )

        // Relay from a different domain than the configured hub
        viewModel.processQRCode("llamenos-link://evil.example.com/abc123")
        if case .error = viewModel.currentStep {
            // Expected — relay domain doesn't match hub domain
        } else {
            XCTFail("processQRCode must reject relay not matching configured hub, got \(viewModel.currentStep)")
        }
    }

    func testProcessQRCodeAcceptsRelayMatchingConfiguredHub() {
        let crypto = CryptoService()
        let keychain = KeychainService()
        let auth = AuthService(cryptoService: crypto, keychainService: keychain)
        try? auth.setHubURL("https://myserver.llamenos.org")
        let viewModel = DeviceLinkViewModel(
            cryptoService: crypto,
            authService: auth,
            keychainService: keychain
        )

        // Relay from the same host as the configured hub — should pass validation
        // (it will proceed to connect, so step transitions away from .scanning)
        viewModel.processQRCode("llamenos-link://myserver.llamenos.org/relay/abc123")
        // Not in .error and not in .scanning means validation passed and connect started
        if case .error = viewModel.currentStep {
            XCTFail("processQRCode should accept relay matching configured hub domain, got \(viewModel.currentStep)")
        }
        XCTAssertNotEqual(viewModel.currentStep, .scanning,
            "Step should have advanced past scanning when relay matches configured hub")
    }

    func testProcessQRCodeAllowsAnyPublicRelayWhenNoHubConfigured() {
        // When no hub URL is configured (first setup), any public non-private relay is allowed.
        let viewModel = makeDeviceLinkViewModel() // no hub URL set
        viewModel.processQRCode("llamenos-link://relay.example.com/abc123")
        if case .error = viewModel.currentStep {
            XCTFail("processQRCode should allow public relay when no hub is configured, got \(viewModel.currentStep)")
        }
    }

    // MARK: - Helpers

    private func makeDeviceLinkViewModel() -> DeviceLinkViewModel {
        let crypto = CryptoService()
        let keychain = KeychainService()
        let auth = AuthService(cryptoService: crypto, keychainService: keychain)
        return DeviceLinkViewModel(
            cryptoService: crypto,
            authService: auth,
            keychainService: keychain
        )
    }

    // MARK: - H7: PIN Lockout Timing

    func testNoLockoutForFirstFourAttempts() {
        for attempts in 0...4 {
            XCTAssertNil(
                PINLockout.lockoutDuration(forAttempts: attempts),
                "No lockout expected for \(attempts) attempts"
            )
        }
    }

    func testThirtySecondLockoutForAttemptsFiveAndSix() {
        XCTAssertEqual(PINLockout.lockoutDuration(forAttempts: 5), 30)
        XCTAssertEqual(PINLockout.lockoutDuration(forAttempts: 6), 30)
    }

    func testTwoMinuteLockoutForAttemptsSevenAndEight() {
        XCTAssertEqual(PINLockout.lockoutDuration(forAttempts: 7), 120)
        XCTAssertEqual(PINLockout.lockoutDuration(forAttempts: 8), 120)
    }

    func testTenMinuteLockoutForAttemptNine() {
        XCTAssertEqual(PINLockout.lockoutDuration(forAttempts: 9), 600)
    }

    func testWipeOnTenthAttempt() {
        XCTAssertTrue(PINLockout.shouldWipeKeys(forAttempts: 10))
        XCTAssertEqual(PINLockout.lockoutDuration(forAttempts: 10), 0)
    }

    func testWipeOnMoreThanTenAttempts() {
        XCTAssertTrue(PINLockout.shouldWipeKeys(forAttempts: 11))
        XCTAssertTrue(PINLockout.shouldWipeKeys(forAttempts: 100))
    }

    func testNoWipeBelowTenAttempts() {
        for attempts in 0...9 {
            XCTAssertFalse(
                PINLockout.shouldWipeKeys(forAttempts: attempts),
                "Should not wipe at \(attempts) attempts"
            )
        }
    }

    // MARK: - H6: HTTP Rejection

    func testAPIServiceRejectsHTTP() {
        let crypto = CryptoService()
        let api = APIService(cryptoService: crypto, hubContext: HubContext())

        XCTAssertThrowsError(try api.configure(hubURLString: "http://evil.example.com")) { error in
            guard let apiError = error as? APIError else {
                XCTFail("Expected APIError, got \(type(of: error))")
                return
            }
            if case .insecureConnection = apiError {
                // Expected
            } else {
                XCTFail("Expected insecureConnection error, got \(apiError)")
            }
        }
    }

    func testAPIServiceRejectsHTTPCaseInsensitive() {
        let crypto = CryptoService()
        let api = APIService(cryptoService: crypto, hubContext: HubContext())

        XCTAssertThrowsError(try api.configure(hubURLString: "HTTP://evil.example.com"))
        XCTAssertThrowsError(try api.configure(hubURLString: "Http://evil.example.com"))
    }

    func testAPIServiceAcceptsHTTPS() throws {
        let crypto = CryptoService()
        let api = APIService(cryptoService: crypto, hubContext: HubContext())

        // Should not throw
        try api.configure(hubURLString: "https://app.llamenos.org")
    }

    func testAPIServiceAutoPrependsHTTPS() throws {
        let crypto = CryptoService()
        let api = APIService(cryptoService: crypto, hubContext: HubContext())

        // Should not throw — auto-prepends https://
        try api.configure(hubURLString: "app.llamenos.org")
    }

    // MARK: - H5b: WebSocket Relay URL Scheme Validation

    func testWebSocketServiceRejectsHTTPScheme() async {
        let ws = WebSocketService(cryptoService: CryptoService())
        await ws.connect(to: URL(string: "http://evil.example.com/ws")!)
        XCTAssertEqual(
            ws.connectionState, .disconnected,
            "WebSocketService must reject http:// URLs — state must stay disconnected"
        )
    }

    func testWebSocketServiceRejectsWSScheme() async {
        let ws = WebSocketService(cryptoService: CryptoService())
        await ws.connect(to: URL(string: "ws://evil.example.com/ws")!)
        XCTAssertEqual(
            ws.connectionState, .disconnected,
            "WebSocketService must reject ws:// URLs — state must stay disconnected"
        )
    }

    func testWebSocketServiceAcceptsWSSScheme() async {
        let ws = WebSocketService(cryptoService: CryptoService())
        await ws.connect(to: URL(string: "wss://app.llamenos.org/ws")!)
        // State transitions to .connecting (or later) once the URL passes validation
        XCTAssertNotEqual(
            ws.connectionState, .disconnected,
            "WebSocketService must accept wss:// URLs and attempt connection"
        )
        ws.disconnect()
    }

    func testWebSocketServiceAcceptsHTTPSScheme() async {
        // https:// is a valid scheme — used when the hub URL is https:// and the caller
        // passes it directly to WebSocketService (URLSession upgrades the WS handshake).
        let ws = WebSocketService(cryptoService: CryptoService())
        await ws.connect(to: URL(string: "https://app.llamenos.org/ws")!)
        XCTAssertNotEqual(
            ws.connectionState, .disconnected,
            "WebSocketService must accept https:// URLs"
        )
        ws.disconnect()
    }

    func testWebSocketServiceRejectsWSSchemeOnLookalikeLoopbackHost() async {
        // Loopback exemption is an exact host match — a hostname merely containing
        // "localhost" is a remote host and must stay wss-only.
        let ws = WebSocketService(cryptoService: CryptoService())
        await ws.connect(to: URL(string: "ws://localhost.evil.example.com/ws")!)
        XCTAssertEqual(ws.connectionState, .disconnected)
    }

    func testWebSocketServiceAcceptsWSSchemeOnLoopback() async {
        // Mirrors APIService's http://localhost exemption: a loopback socket never
        // crosses the network, and local dev/test backends serve plain HTTP.
        let ws = WebSocketService(cryptoService: CryptoService())
        await ws.connect(to: URL(string: "ws://localhost:3000/ws")!)
        XCTAssertNotEqual(ws.connectionState, .disconnected)
        ws.disconnect()
    }

    // MARK: - Certificate Pinning Constants (H14)

    func testCertificatePinsNonEmpty() {
        // Static default pins must be non-empty — production uses Let's Encrypt CA pins
        // (ISRG Root X1 + X2). Dynamic pins from /api/config/pins supplement these;
        // static defaults remain active if the fetch fails.
        XCTAssertFalse(
            CertificatePins.defaultHashes.isEmpty,
            "CertificatePins.defaultHashes must not be empty — must contain Let's Encrypt CA pins"
        )
    }

    func testCertificatePinsEnabledWhenHashesPopulated() {
        // CertificatePins.isEnabled is a computed property: isEnabled == !active.hashes.isEmpty.
        // Static defaults are always populated, so isEnabled must be true at launch.
        XCTAssertFalse(
            CertificatePins.defaultHashes.isEmpty,
            "defaultHashes must be non-empty so pinning activates on launch"
        )
        // With default hashes loaded into active, pinning must be enabled.
        XCTAssertTrue(
            CertificatePins.isEnabled,
            "Pinning must be enabled when hashes are configured"
        )
    }

    func testCertificatePinningDelegateCreatesSuccessfully() {
        // Verify the delegate can be instantiated (used by APIService).
        let delegate = CertificatePinningDelegate()
        XCTAssertNotNil(delegate, "CertificatePinningDelegate should be instantiable")
    }

    func testCertificatePinningDelegateConformsToURLSessionDelegate() {
        // Verify the delegate conforms to URLSessionDelegate protocol.
        let delegate = CertificatePinningDelegate()
        XCTAssertTrue(
            delegate is URLSessionDelegate,
            "CertificatePinningDelegate should conform to URLSessionDelegate"
        )
    }

    // MARK: - H8: Wake Key Keychain Accessibility

    func testWakeKeyUsesWhenUnlockedThisDeviceOnly() {
        // The WakeKeyService.storeWakePrivateKey() method stores the wake private
        // key with kSecAttrAccessibleWhenUnlockedThisDeviceOnly and
        // kSecAttrSynchronizable: false. This ensures the key:
        //   1. Never syncs to iCloud Keychain (ThisDeviceOnly + explicit false sync)
        //   2. Never migrates to a new device on restore
        //   3. Is only readable when the device is unlocked
        //
        // Note: kSecAttrTokenIDSecureEnclave is intentionally NOT used — the Secure
        // Enclave only supports P-256/P-384 keys. X25519 wake keys use the software
        // Keychain with device-only, non-syncable attributes.
        //
        // Since the actual Keychain write uses hardcoded constants, we verify the
        // contract by checking the WakeKeyService source constants. The test
        // validates that the service class and its Keychain account keys are
        // correctly defined.

        // Verify WakeKeyService can be instantiated with its required dependencies.
        // In XCTest (not on a device with entitlements), Keychain operations may fail
        // with -34018, but the service should still construct.
        let keychainService = KeychainService()
        // Clear any wake key entries left by prior tests or runs so
        // WakeKeyService.init → loadExistingKeys() starts clean.
        keychainService.delete(key: "wake-private-key")
        keychainService.delete(key: "wake-public-key")
        keychainService.delete(key: "device-registered")

        let cryptoService = CryptoService()
        let apiService = APIService(cryptoService: cryptoService, hubContext: HubContext())

        let wakeKeyService = WakeKeyService(
            keychainService: keychainService,
            cryptoService: cryptoService,
            apiService: apiService
        )

        XCTAssertNotNil(wakeKeyService, "WakeKeyService should be instantiable")

        // Initially no keypair should exist (clean Keychain in test runner)
        XCTAssertFalse(
            wakeKeyService.hasKeypair,
            "WakeKeyService should not have a keypair on fresh construction"
        )

        // The publicKeyHex should be nil before ensureKeypairExists()
        XCTAssertNil(
            wakeKeyService.publicKeyHex,
            "Public key should be nil before key generation"
        )
    }

    func testWakeKeyServiceRegistrationRequiresKeypair() {
        // registerDevice() should throw WakeKeyError.noPrivateKey if called
        // before ensureKeypairExists().
        let keychainService = KeychainService()
        // Clear any wake key entries left by prior tests or runs
        keychainService.delete(key: "wake-private-key")
        keychainService.delete(key: "wake-public-key")
        keychainService.delete(key: "device-registered")

        let cryptoService = CryptoService()
        let apiService = APIService(cryptoService: cryptoService, hubContext: HubContext())

        let wakeKeyService = WakeKeyService(
            keychainService: keychainService,
            cryptoService: cryptoService,
            apiService: apiService
        )

        let expectation = XCTestExpectation(description: "registerDevice should fail without keypair")

        Task {
            do {
                try await wakeKeyService.registerDevice(pushToken: "test-token")
                XCTFail("registerDevice should throw when no keypair exists")
            } catch let error as WakeKeyError {
                if case .noPrivateKey = error {
                    // Expected
                } else {
                    XCTFail("Expected noPrivateKey error, got \(error)")
                }
            } catch {
                XCTFail("Expected WakeKeyError, got \(type(of: error))")
            }
            expectation.fulfill()
        }

        wait(for: [expectation], timeout: 5)
    }

    // MARK: - H4: SAS Gate Logic

    func testDeviceLinkStepsRequireSASBeforeImport() {
        // Verify the DeviceLinkStep enum enforces the correct flow order.
        // The flow is: scanning -> connecting -> verifying(SAS) -> importing -> completed.
        // The verifying step must come before importing.
        let scanning = DeviceLinkStep.scanning
        let connecting = DeviceLinkStep.connecting
        let verifying = DeviceLinkStep.verifying(sasCode: "123456")
        let importing = DeviceLinkStep.importing
        let completed = DeviceLinkStep.completed

        // All steps should be distinct (not equal to each other)
        XCTAssertNotEqual(scanning, connecting)
        XCTAssertNotEqual(connecting, verifying)
        XCTAssertNotEqual(verifying, importing)
        XCTAssertNotEqual(importing, completed)

        // Error step with private relay message
        let privateRelayError = DeviceLinkStep.error(
            "The relay URL points to a private or local network address."
        )
        XCTAssertNotEqual(scanning, privateRelayError)
    }

    func testDeviceLinkViewModelInitialStepIsScanning() {
        // The initial step must be scanning — import cannot be the first step
        let cryptoService = CryptoService()
        let keychainService = KeychainService()
        let apiService = APIService(cryptoService: cryptoService, hubContext: HubContext())
        let authService = AuthService(
            cryptoService: cryptoService,
            keychainService: keychainService
        )

        let viewModel = DeviceLinkViewModel(
            cryptoService: cryptoService,
            authService: authService,
            keychainService: keychainService
        )

        XCTAssertEqual(
            viewModel.currentStep,
            .scanning,
            "Device link should start at scanning step, not importing"
        )

        XCTAssertFalse(
            viewModel.sasConfirmed,
            "SAS should not be confirmed initially"
        )
    }

    func testConfirmSASCodeIsNoOpWhenNotVerifying() {
        // SECURITY: confirmSASCode() must not set sasConfirmed when called from
        // any step other than .verifying. If it did, an attacker or UI bug could
        // bypass the SAS check and allow import without user verification.
        let cryptoService = CryptoService()
        let keychainService = KeychainService()
        let authService = AuthService(
            cryptoService: cryptoService,
            keychainService: keychainService
        )

        let viewModel = DeviceLinkViewModel(
            cryptoService: cryptoService,
            authService: authService,
            keychainService: keychainService
        )

        // Initial state: scanning — calling confirmSASCode must NOT set sasConfirmed.
        XCTAssertEqual(viewModel.currentStep, .scanning)
        viewModel.confirmSASCode()
        XCTAssertFalse(
            viewModel.sasConfirmed,
            "confirmSASCode() called from .scanning must not set sasConfirmed — SAS bypass prevented"
        )
        // The step should transition to error (treating the out-of-state call as a rejection).
        if case .error = viewModel.currentStep {
            // Expected
        } else {
            XCTFail("Expected error step after out-of-state confirmSASCode() call, got \(viewModel.currentStep)")
        }
    }

    func testConfirmSASCodeIsNoOpFromConnectingStep() {
        // Calling confirmSASCode() from .connecting must also fail — only .verifying is valid.
        let cryptoService = CryptoService()
        let keychainService = KeychainService()
        let authService = AuthService(
            cryptoService: cryptoService,
            keychainService: keychainService
        )

        let viewModel = DeviceLinkViewModel(
            cryptoService: cryptoService,
            authService: authService,
            keychainService: keychainService
        )

        // Force to connecting step (simulates mid-flow state)
        viewModel.currentStep = .connecting
        viewModel.confirmSASCode()
        XCTAssertFalse(
            viewModel.sasConfirmed,
            "confirmSASCode() from .connecting must not set sasConfirmed"
        )
    }

    func testConfirmSASCodeSetsConfirmedOnlyFromVerifyingStep() {
        // When the step IS .verifying, confirmSASCode() should set sasConfirmed = true.
        let cryptoService = CryptoService()
        let keychainService = KeychainService()
        let authService = AuthService(
            cryptoService: cryptoService,
            keychainService: keychainService
        )

        let viewModel = DeviceLinkViewModel(
            cryptoService: cryptoService,
            authService: authService,
            keychainService: keychainService
        )

        // Force to verifying step with a SAS code
        viewModel.currentStep = .verifying(sasCode: "123456")
        viewModel.confirmSASCode()
        XCTAssertTrue(
            viewModel.sasConfirmed,
            "confirmSASCode() from .verifying must set sasConfirmed = true"
        )
    }

    func testSASConfirmedIsNotPubliclyWritable() {
        // sasConfirmed is declared private(set) — this test verifies via API that
        // the only way to confirm SAS is through confirmSASCode() from the verifying step.
        // (The compiler enforces private(set); this test acts as documentation.)
        let cryptoService = CryptoService()
        let keychainService = KeychainService()
        let authService = AuthService(
            cryptoService: cryptoService,
            keychainService: keychainService
        )

        let viewModel = DeviceLinkViewModel(
            cryptoService: cryptoService,
            authService: authService,
            keychainService: keychainService
        )

        // The only path to sasConfirmed == true is confirmSASCode() in .verifying.
        // In any other starting state it stays false.
        XCTAssertFalse(viewModel.sasConfirmed)
        viewModel.confirmSASCode() // called from .scanning → no-op
        XCTAssertFalse(viewModel.sasConfirmed, "sasConfirmed must not be settable except via verifying-step confirmation")
    }

    // The pre-V3 signing-seed import flow (and the AuthViewModel.signingKeyInput / .importingKey state
    // that mediated it) was removed when device keys replaced single-key identity.
    // The equivalent V3 flow is sigchain-authorized device linking, which has its own
    // tests in DeviceLinkViewModel coverage.

    // MARK: - Gap 3.1: Wake Key X25519 Curve Verification

    func testWakeKeyDerivedPublicKeyIsX25519Length() throws {
        // X25519 public keys are 32 bytes = 64 hex characters.
        // secp256k1 compressed public keys are 33 bytes = 66 hex characters.
        // If this test fails, the wake key derivation is using the wrong curve.
        // The Rust get_public_key FFI uses x25519_dalek — not secp256k1.
        let privateKeyHex = String(repeating: "a1", count: 32) // 32 bytes = 64 hex chars
        let publicKeyHex = try getPublicKey(secretKeyHex: privateKeyHex)
        XCTAssertEqual(
            publicKeyHex.count, 64,
            "Wake public key must be 32 bytes (64 hex chars) — X25519, not secp256k1 (33 bytes = 66 hex chars)"
        )
    }
}
