import Foundation

/// Case triage state — a record's status and severity — as hub-keyed blind
/// indexes (#2779).
///
/// `statusHash` / `severityHash` hold the crate's `HMAC(field key, value)`, the
/// field key derived in Rust from the hub key (`blind_index::field_blind_indexes`).
/// The server can filter by equality but cannot tell which value a token stands
/// for. A client maps a token back by computing the tokens of each entity type's
/// own vocabulary — never by reading a value off the wire. A token that is none
/// of the type's values resolves to nil, so a view shows no status rather than
/// the token.
struct TriageTokens: Sendable {
    /// Entity type id → token → status value.
    private var statusByType: [String: [String: String]] = [:]
    /// Entity type id → token → severity value.
    private var severityByType: [String: [String: String]] = [:]

    static let empty = TriageTokens()

    /// The status value `token` stands for in entity type `entityTypeId`.
    func statusValue(entityTypeId: String?, token: String?) -> String? {
        guard let entityTypeId, let token else { return nil }
        return statusByType[entityTypeId]?[token]
    }

    /// The severity value `token` stands for in entity type `entityTypeId`.
    func severityValue(entityTypeId: String?, token: String?) -> String? {
        guard let entityTypeId, let token else { return nil }
        return severityByType[entityTypeId]?[token]
    }

    /// The token a status value is written as, under `hubId`'s key. Throws when
    /// the hub key is not loaded: a status is never written as plaintext.
    static func statusToken(_ crypto: CryptoService, hubId: String, value: String) throws -> String {
        try single(crypto.blindIndexTokens(hubId: hubId, fieldLabel: CryptoLabels.HMAC_CASE_STATUS, values: [value]))
    }

    /// The token a severity value is written as, under `hubId`'s key.
    static func severityToken(_ crypto: CryptoService, hubId: String, value: String) throws -> String {
        try single(crypto.blindIndexTokens(hubId: hubId, fieldLabel: CryptoLabels.HMAC_CASE_SEVERITY, values: [value]))
    }

    /// Token → value lookups for every entity type in `types`, under `hubId`'s key.
    static func compute(_ crypto: CryptoService, hubId: String, types: [EntityType]) throws -> TriageTokens {
        func lookup(_ label: String, _ values: [String]) throws -> [String: String] {
            guard !values.isEmpty else { return [:] }
            let tokens = try crypto.blindIndexTokens(hubId: hubId, fieldLabel: label, values: values)
            return Dictionary(zip(tokens, values), uniquingKeysWith: { first, _ in first })
        }
        var result = TriageTokens()
        for type in types {
            result.statusByType[type.id] = try lookup(CryptoLabels.HMAC_CASE_STATUS, type.statuses.map(\.value))
            result.severityByType[type.id] = try lookup(CryptoLabels.HMAC_CASE_SEVERITY, (type.severities ?? []).map(\.value))
        }
        return result
    }

    private static func single(_ tokens: [String]) throws -> String {
        guard tokens.count == 1, let token = tokens.first else {
            throw TriageTokenError.unexpectedTokenCount(tokens.count)
        }
        return token
    }
}

enum TriageTokenError: Error {
    case unexpectedTokenCount(Int)
}
