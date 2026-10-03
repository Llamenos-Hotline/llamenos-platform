import Foundation
import AVFoundation

// MARK: - DeviceLinkStep

/// Steps in the device linking flow.
enum DeviceLinkStep: Equatable {
    /// Waiting for the user to scan a QR code.
    case scanning
    /// Connecting to the provisioning room on the relay.
    case connecting
    /// Verifying identity via SAS code.
    case verifying(sasCode: String)
    /// Importing the decrypted device key.
    case importing
    /// Successfully linked.
    case completed
    /// An error occurred.
    case error(String)
}

// MARK: - DeviceLinkViewModel

/// View model for the device linking flow. Handles QR code scanning, Nostr relay
/// ephemeral ECDH key exchange, SAS verification, and device key provisioning.
///
/// Protocol flow:
/// 1. Desktop generates a provisioning room ID and relay URL, encodes in QR.
/// 2. Mobile scans QR, connects to relay, joins the provisioning room.
/// 3. Both sides generate ephemeral ECDH keypairs and exchange public keys.
/// 4. Both derive the same shared secret and SAS code for visual verification.
/// 5. User confirms SAS codes match on both devices.
/// 6. Desktop encrypts the device provisioning data with the shared secret and sends it.
/// 7. Mobile decrypts and creates new device keys linked to the same user identity.
@Observable
final class DeviceLinkViewModel {
    private let cryptoService: CryptoService
    private let authService: AuthService
    private let keychainService: KeychainService

    // MARK: - Public State

    /// Current step in the linking flow.
    var currentStep: DeviceLinkStep = .scanning

    /// Whether camera access has been granted.
    var hasCameraPermission: Bool = false

    /// Whether the user confirmed the SAS code match.
    /// `private(set)` — external code may read this but must never set it directly.
    /// SAS confirmation is only valid from the `.verifying` step via `confirmSASCode()`.
    private(set) var sasConfirmed: Bool = false

    /// Error message for the current step.
    var errorMessage: String?

    // MARK: - Private State

    /// The provisioning room ID from the QR code.
    private var provisioningRoomId: String?

    /// The relay URL from the QR code.
    private var relayURL: String?

    /// Our ephemeral keypair for this linking session.
    private var ephemeralSecret: String?
    private var ephemeralPublic: String?

    /// The other device's ephemeral public key.
    private var theirEphemeralPublic: String?

    /// The derived shared secret.
    private var sharedSecret: String?

    /// Encrypted provisioning data received before SAS confirmation (H4).
    /// Held pending until the user confirms SAS codes match.
    private var pendingEncryptedData: String?

    /// WebSocket task for the provisioning relay connection.
    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var session: URLSession

    // MARK: - Initialization

    init(cryptoService: CryptoService, authService: AuthService, keychainService: KeychainService) {
        self.cryptoService = cryptoService
        self.authService = authService
        self.keychainService = keychainService
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
    }

    // MARK: - Camera Permission

    /// Request camera access for QR code scanning.
    func requestCameraPermission() async {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            hasCameraPermission = true
        case .notDetermined:
            hasCameraPermission = await AVCaptureDevice.requestAccess(for: .video)
        case .denied, .restricted:
            hasCameraPermission = false
        @unknown default:
            hasCameraPermission = false
        }
    }

    // MARK: - QR Code Processing

    /// Process a scanned QR code string. Expected format:
    /// `llamenos-link://<relay-url>/<room-id>`
    func processQRCode(_ code: String) {
        guard code.hasPrefix("llamenos-link://") else {
            currentStep = .error(NSLocalizedString(
                "device_link_invalid_qr",
                comment: "Invalid QR code. Scan the code shown on your desktop app."
            ))
            return
        }

        let payload = String(code.dropFirst("llamenos-link://".count))
        let parts = payload.split(separator: "/", maxSplits: 1)

        guard parts.count == 2 else {
            currentStep = .error(NSLocalizedString(
                "device_link_invalid_format",
                comment: "QR code format is invalid."
            ))
            return
        }

        // First part is the relay URL (may contain path), last component is room ID
        let fullPath = String(payload)
        guard let lastSlash = fullPath.lastIndex(of: "/") else {
            currentStep = .error(NSLocalizedString(
                "device_link_invalid_format",
                comment: "QR code format is invalid."
            ))
            return
        }

        let relayPart = String(fullPath[fullPath.startIndex..<lastSlash])
        let roomId = String(fullPath[fullPath.index(after: lastSlash)...])

        // H5: Validate the relay host to prevent SSRF to internal networks.
        // Use URL parsing for reliable host extraction — manual splitting on ":" fails
        // for IPv6 addresses like [::1], which would be truncated to "[" and bypass
        // all private-range checks.
        guard let parsedRelayURL = URL(string: "wss://\(relayPart)"),
              let extractedHost = parsedRelayURL.host, !extractedHost.isEmpty else {
            currentStep = .error(NSLocalizedString(
                "device_link_invalid_relay",
                comment: "Invalid relay URL."
            ))
            return
        }
        guard Self.isValidRelayHost(extractedHost) else {
            currentStep = .error(NSLocalizedString(
                "device_link_private_relay",
                comment: "The relay URL points to a private or local network address. This is not allowed for security reasons."
            ))
            return
        }

        // H5b: If a hub URL is already configured, the relay must originate from
        // the same host — prevents redirecting device linking to an attacker's server.
        if let hubURLString = authService.hubURL,
           let hubURL = URL(string: hubURLString),
           let hubHost = hubURL.host, !hubHost.isEmpty {
            guard extractedHost.lowercased() == hubHost.lowercased() else {
                currentStep = .error(NSLocalizedString(
                    "device_link_relay_domain_mismatch",
                    comment: "The relay URL does not match your configured server. Scan the QR code shown on your own server's desktop app."
                ))
                return
            }
        }

        relayURL = "wss://\(relayPart)"
        provisioningRoomId = roomId

        // Transition to connecting state before launching the async connection
        currentStep = .connecting

        // Start the connection
        Task {
            await connectToProvisioningRoom()
        }
    }

    // MARK: - Provisioning Room Connection

    /// Connect to the relay and join the provisioning room for ECDH exchange.
    private func connectToProvisioningRoom() async {
        currentStep = .connecting

        guard let urlString = relayURL, let url = URL(string: urlString) else {
            currentStep = .error(NSLocalizedString(
                "device_link_invalid_relay",
                comment: "Invalid relay URL."
            ))
            return
        }

        // Generate our ephemeral keypair
        let keypair = cryptoService.generateEphemeralKeypair()
        ephemeralSecret = keypair.secretHex
        ephemeralPublic = keypair.publicHex

        // Connect to the relay
        let task = session.webSocketTask(with: url)
        webSocketTask = task
        task.resume()

        // Subscribe to provisioning room events
        guard let roomId = provisioningRoomId else { return }

        let subscriptionId = "link-\(UUID().uuidString.prefix(8))"
        let reqMessage = """
        ["REQ","\(subscriptionId)",{"kinds":[20001],"#t":["\(CryptoLabels.LABEL_PROVISION_PREFIX)\(roomId)"]}]
        """

        do {
            try await task.send(.string(reqMessage))
        } catch {
            currentStep = .error(NSLocalizedString(
                "device_link_connect_failed",
                comment: "Failed to connect to relay."
            ))
            return
        }

        // Send our ephemeral public key to the room
        guard let pubKey = ephemeralPublic else { return }
        let eventContent = """
        {"type":"ephemeral-pubkey","pubkey":"\(pubKey)"}
        """
        let eventMessage = """
        ["EVENT",{"kind":20001,"content":"\(eventContent.replacingOccurrences(of: "\"", with: "\\\""))","tags":[["t","\(CryptoLabels.LABEL_PROVISION_PREFIX)\(roomId)"]],"created_at":\(Int(Date().timeIntervalSince1970))}]
        """

        do {
            try await task.send(.string(eventMessage))
        } catch {
            currentStep = .error(NSLocalizedString(
                "device_link_send_failed",
                comment: "Failed to send key exchange data."
            ))
            return
        }

        // Start receiving messages
        receiveTask = Task { [weak self] in
            await self?.receiveProvisioningMessages()
        }
    }

    // MARK: - Message Handling

    /// Receive and process messages from the provisioning room.
    private func receiveProvisioningMessages() async {
        guard let task = webSocketTask else { return }

        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                switch message {
                case .string(let text):
                    await processProvisioningMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        await processProvisioningMessage(text)
                    }
                @unknown default:
                    break
                }
            } catch {
                if !Task.isCancelled {
                    await MainActor.run {
                        currentStep = .error(NSLocalizedString(
                            "device_link_connection_lost",
                            comment: "Connection to relay lost."
                        ))
                    }
                }
                return
            }
        }
    }

    /// Parse a relay message and handle provisioning events.
    @MainActor
    private func processProvisioningMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [Any],
              let type = array.first as? String,
              type == "EVENT",
              array.count >= 3,
              let eventDict = array[2] as? [String: Any],
              let content = eventDict["content"] as? String else {
            return
        }

        // Parse the content JSON
        guard let contentData = content.data(using: .utf8),
              let contentObj = try? JSONSerialization.jsonObject(with: contentData) as? [String: Any],
              let messageType = contentObj["type"] as? String else {
            return
        }

        switch messageType {
        case "ephemeral-pubkey":
            // Received the other device's ephemeral public key
            guard let theirPubkey = contentObj["pubkey"] as? String else { return }
            theirEphemeralPublic = theirPubkey

            // Derive shared secret
            guard let ourSecret = ephemeralSecret else { return }
            do {
                let shared = try cryptoService.deriveSharedSecret(ourSecret: ourSecret, theirPublic: theirPubkey)
                sharedSecret = shared

                // Derive and display SAS code
                let sas = try cryptoService.deriveSASCode(sharedSecret: shared)
                currentStep = .verifying(sasCode: sas)
            } catch {
                currentStep = .error(error.localizedDescription)
                return
            }

        case "encrypted-nsec", "encrypted-provision":
            // Received encrypted provisioning data from the desktop.
            // H4: Gate import on SAS confirmation — do NOT import until the user
            // has confirmed the SAS codes match. This prevents MITM attacks.
            guard let encryptedData = contentObj["data"] as? String,
                  let shared = sharedSecret else {
                currentStep = .error(NSLocalizedString(
                    "device_link_decrypt_failed",
                    comment: "Failed to decrypt key data."
                ))
                return
            }

            if sasConfirmed {
                // SAS already confirmed — import immediately.
                // sasConfirmed can only be true if confirmSASCode() was called while
                // in .verifying state (enforced by the guard in confirmSASCode()).
                Task {
                    await importEncryptedProvisionData(encryptedData, sharedSecret: shared)
                }
            } else if case .verifying = currentStep {
                // SAS not yet confirmed, but we're showing it — hold data for when user confirms.
                pendingEncryptedData = encryptedData
            } else {
                // H4: Encrypted data arrived before the SAS screen was shown.
                // Do NOT store pendingEncryptedData — require a clean retry so the
                // user cannot inadvertently confirm SAS for data they never saw arrive.
                currentStep = .error(NSLocalizedString(
                    "device_link_sas_required",
                    comment: "Key received but SAS verification is required first."
                ))
            }

        default:
            break
        }
    }

    // MARK: - SAS Confirmation

    /// Confirm the SAS code matches the desktop display.
    /// If an encrypted device key was received before confirmation, imports it now (H4).
    ///
    /// SECURITY: This function is a no-op (and aborts the flow) if called outside
    /// the `.verifying` step. This prevents SAS bypass via state manipulation.
    func confirmSASCode() {
        // H4: Enforce state machine — SAS confirmation is only valid from verifying step.
        // Calling this from any other step (e.g., connecting, error) is an indication
        // of a bug or an attempt to bypass the check. Treat it as a rejection.
        guard case .verifying = currentStep else {
            rejectSASCode()
            return
        }
        sasConfirmed = true

        // Send confirmation to the other device
        guard let task = webSocketTask, let roomId = provisioningRoomId else { return }

        let confirmContent = "{\"type\":\"sas-confirmed\"}"
        let confirmMessage = """
        ["EVENT",{"kind":20001,"content":"\(confirmContent.replacingOccurrences(of: "\"", with: "\\\""))","tags":[["t","\(CryptoLabels.LABEL_PROVISION_PREFIX)\(roomId)"]],"created_at":\(Int(Date().timeIntervalSince1970))}]
        """

        Task {
            try? await task.send(.string(confirmMessage))
        }

        // H4: Process any pending encrypted data that arrived before SAS confirmation
        if let encrypted = pendingEncryptedData, let shared = sharedSecret {
            pendingEncryptedData = nil
            Task {
                await importEncryptedProvisionData(encrypted, sharedSecret: shared)
            }
        }
    }

    /// Reject the SAS code (possible MITM).
    func rejectSASCode() {
        cleanup()
        currentStep = .error(NSLocalizedString(
            "device_link_sas_mismatch",
            comment: "SAS codes did not match. The linking process has been aborted for security."
        ))
    }

    // MARK: - Device Provisioning Import

    /// Decrypt and process provisioning data received from the desktop.
    ///
    /// NOT IMPLEMENTED: this verifies signatures over the payload and then
    /// discards it — no key material is imported and no device is linked, so
    /// reaching `.completed` here does not mean this device can decrypt
    /// anything. Two things are missing:
    ///
    /// 1. `cryptoService.decryptWithSharedSecret` maps to
    ///    `decrypt_with_shared_key_hex`, whose associated data is
    ///    `LABEL_DEVICE_PROVISION`. The desktop primary sends a device key
    ///    bundle under `LABEL_DEVICE_PROVISION_BUNDLE` (PROTOCOL.md §6.1.1),
    ///    which fails the tag check here by design. Mobile needs a binding for
    ///    `provisioning::decrypt_provisioned_bundle` that keeps both seeds
    ///    inside Rust.
    /// 2. This view model speaks to a Nostr-style relay (kind 20001 events);
    ///    the desktop primary posts to `POST /api/provision/rooms/:id/payload`.
    ///    The two sides never meet on the wire.
    ///
    /// Until both are fixed, mobile device linking does not work. Do not wire
    /// an import here without the bundle path — adopting one seed and deriving
    /// the other produces a device that authenticates and decrypts nothing.
    ///
    /// SECURITY: If the provisioning payload contains a sigchain link, we verify
    /// its Ed25519 signature before trusting the key material. This prevents a
    /// MITM from injecting forged device authorization records during provisioning.
    private func importEncryptedProvisionData(_ encrypted: String, sharedSecret: String) async {
        await MainActor.run {
            currentStep = .importing
        }

        do {
            let decrypted = try cryptoService.decryptWithSharedSecret(
                encrypted: encrypted,
                sharedSecret: sharedSecret
            )

            // Parse the decrypted JSON to check for sigchain data
            if let jsonData = decrypted.data(using: .utf8),
               let payload = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {

                // If the payload includes a sigchain link, verify its signature
                // before trusting any key material in the provisioning data.
                if let sigchainLinkJson = payload["sigchainLink"],
                   let signerPubkey = payload["signerPubkey"] as? String {
                    let linkData = try JSONSerialization.data(withJSONObject: sigchainLinkJson)
                    let linkJsonString = String(data: linkData, encoding: .utf8) ?? ""

                    let valid = try cryptoService.verifySigchainLink(
                        linkJson: linkJsonString,
                        expectedSignerPubkey: signerPubkey
                    )
                    if !valid {
                        await MainActor.run {
                            currentStep = .error(NSLocalizedString(
                                "device_link_sigchain_invalid",
                                comment: "Sigchain verification failed — the provisioning data may have been tampered with."
                            ))
                        }
                        return
                    }
                }

                // If the payload includes a signature over the provision data,
                // verify it against the provisioning device's pubkey.
                if let signature = payload["signature"] as? String,
                   let signerPubkey = payload["signerPubkey"] as? String,
                   let signedData = payload["signedPayload"] as? String {
                    let messageHex = signedData.data(using: .utf8)!
                        .map { String(format: "%02x", $0) }.joined()
                    let valid = try cryptoService.ed25519Verify(
                        messageHex: messageHex,
                        signatureHex: signature,
                        pubkeyHex: signerPubkey
                    )
                    if !valid {
                        await MainActor.run {
                            currentStep = .error(NSLocalizedString(
                                "device_link_signature_invalid",
                                comment: "Provision data signature verification failed — the data may have been tampered with."
                            ))
                        }
                        return
                    }
                }
            }

            // The decrypted data contains provisioning info.
            // This triggers PIN set flow — the user will create device keys
            // protected by a new PIN, then register this device with the hub.

            await MainActor.run {
                currentStep = .completed
            }

            cleanup()
        } catch {
            await MainActor.run {
                currentStep = .error(L10n.format(
                    "device_link_import_failed",
                    comment: "Failed to import key: %@",
                    error.localizedDescription
                ))
            }
        }
    }

    // MARK: - Cancel / Cleanup

    /// Cancel the linking flow and clean up resources.
    func cancel() {
        cleanup()
        currentStep = .scanning
    }

    /// Reset to scanning state after an error.
    func retry() {
        cleanup()
        currentStep = .scanning
    }

    // MARK: - Relay URL Validation (H5)

    /// Validate that a relay host is not a private/internal IP address or localhost.
    /// Prevents SSRF attacks via malicious QR codes pointing to internal networks.
    ///
    /// Rejects: localhost, 127.x, ::1, [::1], 10.x, 172.16–31.x, 192.168.x,
    /// 169.254.x, fe80: (link-local), ::ffff: (IPv4-mapped private addresses),
    /// 0.0.0.0, :: (unspecified), and empty hosts.
    ///
    /// Note: `processQRCode` uses `URL.host` to extract the host, which strips
    /// brackets from IPv6 literals — `[::1]` → `::1`. The bracketed form is also
    /// rejected here to guard callers who pass the host directly.
    static func isValidRelayHost(_ host: String) -> Bool {
        let lowered = host.lowercased()

        // Reject empty host
        if lowered.isEmpty { return false }

        // Reject localhost and loopback variants (including bracketed IPv6)
        if lowered == "localhost" || lowered == "127.0.0.1" || lowered == "::1" || lowered == "[::1]" {
            return false
        }

        // Reject loopback range 127.x.x.x
        if lowered.hasPrefix("127.") { return false }

        // Reject unspecified / all-interfaces addresses
        if lowered == "0.0.0.0" || lowered == "::" { return false }

        // Reject private IPv4 ranges
        let blockedIPv4Prefixes = ["10.", "192.168.", "169.254."]
            + (16...31).map { "172.\($0)." }
        for prefix in blockedIPv4Prefixes where lowered.hasPrefix(prefix) {
            return false
        }

        // Reject IPv6 link-local (fe80::/10)
        if lowered.hasPrefix("fe80") { return false }

        // Reject IPv4-mapped IPv6 private addresses (::ffff:A.B.C.D).
        // Apply the IPv4 private-range rules to the embedded IPv4 address.
        if lowered.hasPrefix("::ffff:") {
            let ipv4Part = String(lowered.dropFirst("::ffff:".count))
            return isValidRelayHost(ipv4Part)
        }

        return true
    }

    /// Clean up WebSocket and ephemeral key material.
    private func cleanup() {
        receiveTask?.cancel()
        receiveTask = nil
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil

        // Zero out ephemeral secrets and pending data
        ephemeralSecret = nil
        ephemeralPublic = nil
        theirEphemeralPublic = nil
        sharedSecret = nil
        pendingEncryptedData = nil
        sasConfirmed = false
    }

    deinit {
        cleanup()
    }
}
