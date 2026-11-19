import Foundation
import Testing
@testable import Llamenos

/// Who a free-text shift field is sealed to (#2777, #2778).
struct ShiftFieldReadersTests {
    private let admin = String(repeating: "a1", count: 32)
    private let manager = String(repeating: "b2", count: 32)

    @Test func noAdminReaderRefusesTheWrite() {
        #expect(throws: ShiftFieldReadersError.noAdminReader) {
            try ShiftFieldReaders.compose(admin: [], others: [manager])
        }
    }

    @Test func adminEntriesThatAreNotX25519KeysDoNotCountAsAnAdmin() {
        #expect(throws: ShiftFieldReadersError.noAdminReader) {
            try ShiftFieldReaders.compose(admin: ["not-a-key", String(repeating: "a", count: 63)], others: [])
        }
    }

    @Test func adminsComeFirstAndKeysAreDeduplicatedCaseInsensitively() throws {
        let readers = try ShiftFieldReaders.compose(admin: [admin.uppercased()], others: [manager, admin])
        #expect(readers == [admin, manager])
    }

    @Test func anUnreadableFieldSaysSoInsteadOfVanishing() {
        #expect(OpenedShiftField.unreadable.displayText.isEmpty == false)
        #expect(OpenedShiftField.text("childcare").displayText == "childcare")
    }

    @Test func noSealedFieldOpensAsNoField() {
        #expect(OpenedShiftField.open(nil, as: .availabilityReason, with: CryptoService()) == nil)
    }

    @Test func aFieldThisDeviceCannotOpenIsUnreadable() {
        let sealed = SealedShiftField(
            encryptedContent: String(repeating: "00", count: 40),
            envelopes: [SharedAdminEnvelope(ct: String(repeating: "11", count: 48), enc: String(repeating: "22", count: 32), pubkey: admin)]
        )
        #expect(OpenedShiftField.open(sealed, as: .overrideNote, with: CryptoService()) == .unreadable)
    }
}
