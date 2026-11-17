/**
 * Case triage state — a record's status and severity — on the wire as hub-keyed
 * blind indexes (#2779).
 *
 * `statusHash` / `severityHash` hold `HMAC(field key, value)`, where the field
 * key is derived in the Rust crate from the hub key (`blind_index.rs`
 * `field_blind_indexes`). The server never holds the hub key, so it can filter
 * by equality but cannot tell which status a token stands for. A client maps a
 * token back to a status by computing the tokens of its entity types'
 * vocabularies — the reverse lookup below — never by reading a value off the
 * wire.
 *
 * Equality is the point of a blind index: the server still sees which records
 * share a status and how often each token occurs. See the crate's
 * `BLIND_INDEX_FIELDS` doc for what that does and does not protect.
 */
import { useQuery } from '@tanstack/react-query'
import { blindIndexTokens } from '@/lib/platform'
import { useActiveHubId } from '@/lib/hub-owned'
import { HMAC_CASE_SEVERITY, HMAC_CASE_STATUS } from '@shared/crypto-labels'
import type { EntityTypeDefinition, EnumOption } from '@/lib/api'

/** The token a status value is written as. */
export async function statusToken(value: string): Promise<string> {
  const [token] = await blindIndexTokens(HMAC_CASE_STATUS, [value])
  return token
}

/** The token a severity value is written as. */
export async function severityToken(value: string): Promise<string> {
  const [token] = await blindIndexTokens(HMAC_CASE_SEVERITY, [value])
  return token
}

/** Token ↔ option lookups for a set of entity types, under the loaded hub key. */
export interface TriageTokens {
  /** The status option `token` stands for in `entityType`, if it is one of its statuses. */
  statusFor(entityType: EntityTypeDefinition | undefined, token: string | null | undefined): EnumOption | undefined
  /** The severity option `token` stands for in `entityType`, if it is one of its severities. */
  severityFor(entityType: EntityTypeDefinition | undefined, token: string | null | undefined): EnumOption | undefined
  /** The token of a status value, when it belongs to one of the looked-up entity types. */
  statusToken(value: string): string | undefined
}

type OptionByToken = Map<string, EnumOption>

async function tokenMap(field: string, options: EnumOption[]): Promise<{ byToken: OptionByToken; byValue: Map<string, string> }> {
  const byToken: OptionByToken = new Map()
  const byValue = new Map<string, string>()
  if (options.length === 0) return { byToken, byValue }
  const tokens = await blindIndexTokens(field, options.map(o => o.value))
  options.forEach((option, i) => {
    byToken.set(tokens[i], option)
    byValue.set(option.value, tokens[i])
  })
  return { byToken, byValue }
}

export async function computeTriageTokens(entityTypes: EntityTypeDefinition[]): Promise<TriageTokens> {
  const statusByType = new Map<string, OptionByToken>()
  const severityByType = new Map<string, OptionByToken>()
  const statusValueToken = new Map<string, string>()
  await Promise.all(entityTypes.map(async (et) => {
    const [status, severity] = await Promise.all([
      tokenMap(HMAC_CASE_STATUS, et.statuses ?? []),
      tokenMap(HMAC_CASE_SEVERITY, et.severities ?? []),
    ])
    statusByType.set(et.id, status.byToken)
    severityByType.set(et.id, severity.byToken)
    for (const [value, token] of status.byValue) statusValueToken.set(value, token)
  }))
  return {
    statusFor: (et, token) => (et && token ? statusByType.get(et.id)?.get(token) : undefined),
    severityFor: (et, token) => (et && token ? severityByType.get(et.id)?.get(token) : undefined),
    statusToken: (value) => statusValueToken.get(value),
  }
}

/**
 * The triage lookups for `entityTypes` in the active hub. `undefined` while
 * they compute, or when no hub key is loaded — a view then shows no status
 * rather than a token.
 */
export function useTriageTokens(entityTypes: EntityTypeDefinition[]): TriageTokens | undefined {
  const hubId = useActiveHubId()
  const signature = entityTypes.map(et => [
    et.id,
    (et.statuses ?? []).map(s => s.value),
    (et.severities ?? []).map(s => s.value),
  ])
  const { data } = useQuery({
    queryKey: ['triage-tokens', hubId, signature],
    queryFn: () => computeTriageTokens(entityTypes),
    enabled: hubId !== null && entityTypes.length > 0,
    staleTime: Infinity,
  })
  return data
}
