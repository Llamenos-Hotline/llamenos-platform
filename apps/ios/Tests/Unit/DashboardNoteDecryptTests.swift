import Foundation
import Testing
@testable import Llamenos

// MARK: - DashboardNoteDecryptTests

/// `DashboardViewModel.decryptRecentNote` must select an envelope by trying it, not by
/// comparing the server's `authorPubkey` — the author's SIGNING key — against our
/// ENCRYPTION key. That comparison can never match, and while it gated the author
/// envelope, the dashboard dropped every note the volunteer wrote themselves (#1024).
struct DashboardNoteDecryptTests {

    private func makeViewModel(cryptoService: CryptoService) -> DashboardViewModel {
        let hubContext = HubContext()
        return DashboardViewModel(
            apiService: APIService(cryptoService: cryptoService, hubContext: hubContext),
            cryptoService: cryptoService,
            webSocketService: WebSocketService(cryptoService: cryptoService),
            hubContext: hubContext
        )
    }

    private func makeNote(
        author: CryptoService,
        text: String,
        adminPubkeys: [String] = []
    ) throws -> NoteResponse {
        let recipients = [author.encryptionPubkeyHex!] + adminPubkeys
        let result = try author.encryptNote(
            payload: #"{"text":"\#(text)"}"#,
            recipientPubkeys: recipients
        )
        let authorEnvelope = result.envelopes.first { $0.pubkey == author.encryptionPubkeyHex }
        let adminEnvelopes = result.envelopes
            .filter { $0.pubkey != author.encryptionPubkeyHex }
            .map { SharedAdminEnvelope(ct: $0.envelope.ct, enc: $0.envelope.enc, pubkey: $0.pubkey) }
        return NoteResponse(
            adminEnvelopes: adminEnvelopes.isEmpty ? nil : adminEnvelopes,
            authorEnvelope: authorEnvelope.map { SharedAuthorEnvelope(ct: $0.envelope.ct, enc: $0.envelope.enc) },
            // The server stores the author's SIGNING pubkey here (the auth identity),
            // not the encryption key the envelope wraps for.
            authorPubkey: author.signingPubkeyHex!,
            callID: "call-1",
            contactHash: nil,
            conversationID: nil,
            createdAt: "2026-10-10T00:00:00Z",
            encryptedContent: result.ciphertextHex,
            id: UUID().uuidString,
            replyCount: nil,
            updatedAt: "2026-10-10T00:00:00Z"
        )
    }

    @Test func authorSeesOwnNotePreviewEvenThoughAuthorPubkeyIsTheSigningKey() throws {
        let author = CryptoService()
        _ = try author.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        // The regression condition: the two keys are different curves.
        #expect(author.signingPubkeyHex != author.encryptionPubkeyHex)
        let vm = makeViewModel(cryptoService: author)

        let note = try makeNote(author: author, text: "own note")
        #expect(vm.decryptRecentNote(note)?.preview == "own note")
    }

    @Test func adminFallsThroughToTheirOwnEnvelope() throws {
        let author = CryptoService()
        _ = try author.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let admin = CryptoService()
        _ = try admin.generateDeviceKeys(deviceId: UUID().uuidString, pin: "87654321")

        let note = try makeNote(author: author, text: "for admin", adminPubkeys: [admin.encryptionPubkeyHex!])
        let vm = makeViewModel(cryptoService: admin)
        #expect(vm.decryptRecentNote(note)?.preview == "for admin")
    }

    @Test func readerWithNoEnvelopeCannotDecrypt() throws {
        let author = CryptoService()
        _ = try author.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let outsider = CryptoService()
        _ = try outsider.generateDeviceKeys(deviceId: UUID().uuidString, pin: "11112222")

        let note = try makeNote(author: author, text: "not for you")
        let vm = makeViewModel(cryptoService: outsider)
        #expect(vm.decryptRecentNote(note) == nil)
    }
}
