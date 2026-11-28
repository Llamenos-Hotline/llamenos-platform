import Foundation

/// The admins of a hub, as the keys its content must be sealed to (#1035).
///
/// Every note, report, reply, contact and case comment is written so that **every**
/// admin of the hub can read it. The server answers that question — `GET
/// /api/hubs/:hubId/readers?purpose=admin` is the registered device X25519 key of
/// every member holding the admin minimum in the hub, plus its escrow key — and the
/// crate decides what to do with the answer (`mobileResolveAdminReaders`: malformed
/// keys dropped, duplicates removed, an empty set refused). Nothing here names a role
/// and nothing here chooses a key.
///
/// What this replaced was `/auth/me`'s single `adminDecryptionPubkey`, an
/// env-configured value: one admin at most, none on a deployment bootstrapped through
/// the setup wizard, and never a reader of hub content (D1). On such a deployment
/// every write was sealed to nobody an admin could be.
enum HubAdminReaders {

    /// The hub's admin reader keys, asked now and never cached.
    ///
    /// - Parameter hubId: The hub of the ROW being written (a conversation's hub, a
    ///   call's hub). `nil` means the hub being browsed, for a row that does not exist
    ///   yet. The browsed hub is never right for an existing row in another hub.
    /// - Throws: ``RecordReadersError/noAdminReader`` when the hub has no admin able to
    ///   read — the caller keeps the user's input on screen and says why, it never
    ///   substitutes another key — or the request's own error.
    static func resolve(apiService: APIService, hubId: String? = nil) async throws -> [String] {
        // Every hub-content seal resolves its admin readers here, so this is where a
        // hub whose authority chain this device has not verified stops sealing
        // (#2963): fail closed — no gate, no seal.
        let sealingHub = try hubId ?? apiService.activeHubIdOrThrow()
        guard let chain = apiService.hubChain else {
            throw HubChainService.ChainError.sealingStopped(hubId: sealingHub)
        }
        try await chain.assertSealable(hubId: sealingHub)
        // The readers of exactly the hub the gate just passed — never the active hub
        // read a second time, which could have changed in between.
        let response: HubReadersResponse = try await apiService.request(
            method: "GET",
            path: APIService.hubPath(sealingHub, "/api/readers?purpose=\(ReaderPurpose.admin.rawValue)")
        )
        return try admins(from: response.recipients)
    }

    /// The crate's rule applied to a server answer, mapped to the error screens show.
    static func admins(from serverRecipients: [String]) throws -> [String] {
        do {
            return try mobileResolveAdminReaders(serverRecipients: serverRecipients)
        } catch CryptoError.NoAdminReader {
            throw RecordReadersError.noAdminReader
        }
    }
}
