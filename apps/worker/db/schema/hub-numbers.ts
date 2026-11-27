import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { hubs } from './settings'
import { providerConfigs } from './provider-setup'

/**
 * The numbers a hotline answers on — the one store inbound routing reads
 * (`HubService.getHubByPhone`) and every provider path writes (#1331).
 *
 * `number` is E.164 (`lib/phone-number.ts`) and unique across the deployment: a
 * dialled number belongs to at most one hub, which is what makes the lookup
 * unambiguous.
 *
 * `source` records how the number got here, because the two have different
 * authority over it:
 * - `declared`: an operator told us. A self-hosted PBX has no number API — the
 *   carrier delivers DIDs, so the operator states which ones are this hub's.
 * - `provisioned`: bought through a hosted provider's number API
 *   (`ProviderSetup.provisionNumber`).
 *
 * `scope` records who vouched for it, because that decides which calls it may
 * route (`HubService.getHubByPhone`):
 * - `platform`: set by someone with instance authority (`system:manage-hubs`):
 *   a call to it routes to the hub whichever provider account delivered it.
 * - `hub`: set by a hub's own provider administrator (`telephony:manage-providers`
 *   inside the hub). It routes only a call delivered through that hub's OWN
 *   provider account (the webhook URL names `?hub=`). A hub administrator can
 *   say which numbers their provider account delivers; they cannot claim a
 *   number that reaches the instance through the platform account, which is
 *   how a declared number would otherwise hijack another hub's callers.
 *   Instance authority outranks it: declaring the number with `platform` scope
 *   takes it over.
 *
 * `provider_config_id` ties a number to the provider config it was bought
 * through; `ON DELETE SET NULL` because removing the provider does not release
 * the number from the hub that is still answering on it.
 *
 * Plaintext by necessity: the routing lookup runs server-side on a webhook
 * with no hub key. (The number identifies the hotline, so this is a decision
 * recorded rather than an oversight — the number is already in the carrier's
 * records and on the public hotline poster.)
 */
export const hubNumbers = pgTable('hub_numbers', {
  id: text('id').primaryKey(),
  hubId: text('hub_id').notNull().references(() => hubs.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  source: text('source').notNull(),
  scope: text('scope').notNull(),
  providerConfigId: text('provider_config_id').references(() => providerConfigs.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hub_numbers_number_unique').on(table.number),
  index('hub_numbers_hub_idx').on(table.hubId),
  check('hub_numbers_scope_check', sql`${table.scope} IN ('platform', 'hub')`),
  check('hub_numbers_source_check', sql`${table.source} IN ('declared', 'provisioned')`),
  check('hub_numbers_e164_check', sql`${table.number} ~ '^\\+[0-9]{7,15}$'`),
])

export type HubNumberSource = 'declared' | 'provisioned'
export type HubNumberScope = 'platform' | 'hub'
