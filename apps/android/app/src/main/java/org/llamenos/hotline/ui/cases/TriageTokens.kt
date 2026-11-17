package org.llamenos.hotline.ui.cases

import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.model.EntityTypeDefinition
import org.llamenos.protocol.CryptoLabels

/**
 * Case triage state — a record's status and severity — as hub-keyed blind
 * indexes (#2779).
 *
 * `statusHash` / `severityHash` hold the crate's `HMAC(field key, value)`, the
 * field key derived in Rust from the hub key (`blind_index::field_blind_indexes`).
 * The server can filter by equality but cannot tell which value a token stands
 * for. The client maps a token back by computing the tokens of each entity
 * type's own vocabulary — never by reading a value off the wire. A token that
 * is none of the type's values resolves to null, so a view shows no status
 * rather than the token.
 */
class TriageTokens private constructor(
    private val statusByType: Map<String, Map<String, String>>,
    private val severityByType: Map<String, Map<String, String>>,
) {
    /** The status value [token] stands for in entity type [entityTypeId]. */
    fun statusValue(entityTypeId: String?, token: String?): String? =
        if (entityTypeId == null || token == null) null else statusByType[entityTypeId]?.get(token)

    /** The severity value [token] stands for in entity type [entityTypeId]. */
    fun severityValue(entityTypeId: String?, token: String?): String? =
        if (entityTypeId == null || token == null) null else severityByType[entityTypeId]?.get(token)

    companion object {
        val EMPTY = TriageTokens(emptyMap(), emptyMap())

        /** The token a status value is written as, under [hubId]'s key. */
        suspend fun statusToken(crypto: CryptoService, hubId: String, value: String): String =
            crypto.blindIndexTokens(hubId, CryptoLabels.HMAC_CASE_STATUS, listOf(value)).single()

        /** The token a severity value is written as, under [hubId]'s key. */
        suspend fun severityToken(crypto: CryptoService, hubId: String, value: String): String =
            crypto.blindIndexTokens(hubId, CryptoLabels.HMAC_CASE_SEVERITY, listOf(value)).single()

        /** Token → value lookups for every entity type in [types], under [hubId]'s key. */
        suspend fun compute(
            crypto: CryptoService,
            hubId: String,
            types: List<EntityTypeDefinition>,
        ): TriageTokens {
            suspend fun lookup(label: String, values: List<String>): Map<String, String> {
                if (values.isEmpty()) return emptyMap()
                val tokens = crypto.blindIndexTokens(hubId, label, values)
                return tokens.zip(values).toMap()
            }
            val status = types.associate { it.id to lookup(CryptoLabels.HMAC_CASE_STATUS, it.statuses.map { s -> s.value }) }
            val severity = types.associate {
                it.id to lookup(CryptoLabels.HMAC_CASE_SEVERITY, it.severities.orEmpty().map { s -> s.value })
            }
            return TriageTokens(status, severity)
        }
    }
}
