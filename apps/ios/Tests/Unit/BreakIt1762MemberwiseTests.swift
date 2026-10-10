import XCTest
@testable import Llamenos

// #1762 break-it verification — THROWAWAY, never merge.
// Deliberately constructs the generated `RecordContact` with arguments in
// Zod schema order rather than generated declaration order (the #1758
// shape). The generated struct declares `addedAt, addedBy, contactID,
// recordID, role`; this passes `recordID` first, which must NOT compile.
final class BreakIt1762MemberwiseTests: XCTestCase {
    func testMemberwiseOrder() {
        let _ = RecordContact(recordID: "r1", contactID: "c1", role: "owner", addedAt: "t", addedBy: "me")
    }
}
