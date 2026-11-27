import { asc, eq, inArray } from 'drizzle-orm'
import type { Database } from '../db'
import { hubNumbers, type HubNumberScope, type HubNumberSource } from '../db/schema'
import { isDuplicateKeyError } from '../lib/db-errors'
import { normalizeE164 } from '../lib/phone-number'
import { ServiceError } from './service-error'

/** What a query or write needs: a `Database` or an open transaction on it. */
type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>

export interface HubNumber {
  id: string
  hubId: string
  /** E.164. */
  number: string
  source: HubNumberSource
  /** Who vouched for it — see `hub_numbers.scope`. */
  scope: HubNumberScope
  providerConfigId: string | null
}

function fromRow(row: typeof hubNumbers.$inferSelect): HubNumber {
  return {
    id: row.id,
    hubId: row.hubId,
    number: row.number,
    source: row.source as HubNumberSource,
    scope: row.scope as HubNumberScope,
    providerConfigId: row.providerConfigId,
  }
}

/**
 * Read a number an operator or a provider hands over and return its E.164 form,
 * or refuse with a 400 naming it. The declaring endpoints use this so a typo is
 * an error at entry, not a hotline that silently routes nowhere.
 */
export function requireE164(raw: string): string {
  const number = normalizeE164(raw)
  if (!number) {
    throw new ServiceError(
      400,
      `"${raw}" is not a telephone number this server can read. Enter it in E.164 form (+15551234567), or set DEFAULT_PHONE_COUNTRY to accept national formats.`,
    )
  }
  return number
}

function numberTakenError(): ServiceError {
  return new ServiceError(409, 'That number already belongs to another hub')
}

/**
 * The numbers a hub answers on, oldest first. The first is the hub's primary
 * number (`Hub.phoneNumber`).
 */
export async function loadHubNumbers(db: Executor, hubIds: readonly string[]): Promise<Map<string, HubNumber[]>> {
  const byHub = new Map<string, HubNumber[]>()
  if (hubIds.length === 0) return byHub
  const rows = await db
    .select()
    .from(hubNumbers)
    .where(inArray(hubNumbers.hubId, [...hubIds]))
    .orderBy(asc(hubNumbers.createdAt), asc(hubNumbers.number))
  for (const row of rows) {
    const list = byHub.get(row.hubId) ?? []
    list.push(fromRow(row))
    byHub.set(row.hubId, list)
  }
  return byHub
}

/** Can a writer with `scope` authority remove or replace this row? Hub authority cannot touch what instance authority set. */
function mayReplace(scope: HubNumberScope, row: Pick<HubNumber, 'source' | 'scope'>): boolean {
  return row.source === 'declared' && (scope === 'platform' || row.scope === 'hub')
}

/**
 * Make `number` one of the hub's, with `scope` authority behind it.
 *
 * Already the hub's: kept, and raised to `platform` when instance authority
 * vouches for it now. Another hub's: a 409 — one dialled number routes to one
 * hub — unless instance authority is claiming a number that only another hub's
 * own administrator declared, which it outranks (otherwise a hub administrator
 * could squat an instance's number and block its rightful hub from ever
 * declaring it). A provisioned number is never taken: it was bought.
 */
async function claim(
  db: Executor,
  hubId: string,
  number: string,
  scope: HubNumberScope,
  createdAt?: Date,
): Promise<void> {
  const [held] = await db.select().from(hubNumbers).where(eq(hubNumbers.number, number)).limit(1)
  if (held) {
    if (held.hubId === hubId) {
      if (scope === 'platform' && held.scope === 'hub') {
        await db.update(hubNumbers).set({ scope: 'platform' }).where(eq(hubNumbers.id, held.id))
      }
      return
    }
    if (scope === 'platform' && held.source === 'declared' && held.scope === 'hub') {
      await db.delete(hubNumbers).where(eq(hubNumbers.id, held.id))
    } else {
      throw numberTakenError()
    }
  }
  await insertOne(db, hubId, number, 'declared', scope, null, createdAt)
}

/**
 * Make `numbers` the whole set of numbers an operator has declared for a hub:
 * absent ones are added, ones no longer listed are removed. Numbers bought
 * through a provider (`source = 'provisioned'`) are never touched — an operator
 * editing their DID list does not release a number they paid for. Nor can a
 * `hub`-scope writer remove a number instance authority set.
 *
 * A number already held by another hub is a 409 (see {@link claim}).
 */
export async function replaceDeclaredNumbers(
  db: Executor,
  hubId: string,
  numbers: readonly string[],
  scope: HubNumberScope,
): Promise<HubNumber[]> {
  const wanted = [...new Set(numbers.map(requireE164))]
  const wantedSet = new Set(wanted)
  const current = (await loadHubNumbers(db, [hubId])).get(hubId) ?? []

  const stale = current.filter((n) => mayReplace(scope, n) && !wantedSet.has(n.number))
  if (stale.length > 0) {
    await db.delete(hubNumbers).where(inArray(hubNumbers.id, stale.map((n) => n.id)))
  }

  // One transaction stamps every row with the same `now()`, so the order the
  // operator listed them in is written into `created_at` explicitly.
  const base = Date.now()
  let offset = 0
  for (const number of wanted) {
    await claim(db, hubId, number, scope, new Date(base + offset++))
  }
  return (await loadHubNumbers(db, [hubId])).get(hubId) ?? []
}

/**
 * Replace the hub's primary declared number with `primary`, leaving every other
 * number alone. This is what the single-number `phoneNumber` field of the hub
 * forms means: "this is the hotline number", not "these are all of them" — a
 * client that shows one number must not, by saving an unrelated edit, drop the
 * hub's other DIDs. An empty value removes the primary. A number the hub
 * already holds is a no-op.
 *
 * The replacement takes the replaced row's `created_at`, so it keeps its place
 * in the order `loadHubNumbers` returns.
 */
export async function setPrimaryDeclaredNumber(
  db: Executor,
  hubId: string,
  primary: string,
  scope: HubNumberScope,
): Promise<HubNumber[]> {
  const all = (await loadHubNumbers(db, [hubId])).get(hubId) ?? []
  const replaceable = all.find((n) => mayReplace(scope, n))
  const wanted = primary.trim() === '' ? null : requireE164(primary)

  if (wanted !== null && all.some((n) => n.number === wanted)) {
    await claim(db, hubId, wanted, scope)
    return (await loadHubNumbers(db, [hubId])).get(hubId) ?? []
  }
  if (replaceable) {
    const [row] = await db.select().from(hubNumbers).where(eq(hubNumbers.id, replaceable.id)).limit(1)
    await db.delete(hubNumbers).where(eq(hubNumbers.id, replaceable.id))
    if (wanted !== null) await claim(db, hubId, wanted, scope, row?.createdAt)
  } else if (wanted !== null) {
    await claim(db, hubId, wanted, scope)
  }
  return (await loadHubNumbers(db, [hubId])).get(hubId) ?? []
}

async function insertOne(
  db: Executor,
  hubId: string,
  number: string,
  source: HubNumberSource,
  scope: HubNumberScope,
  providerConfigId: string | null,
  createdAt?: Date,
): Promise<void> {
  try {
    await db.insert(hubNumbers).values({ id: crypto.randomUUID(), hubId, number, source, scope, providerConfigId, createdAt })
  } catch (err) {
    if (isDuplicateKeyError(err)) throw numberTakenError()
    throw err
  }
}

/**
 * Record a number bought through a provider's number API for a hub. It reaches
 * the instance through that hub's own provider account, so it carries `hub`
 * scope. Idempotent for the hub that already holds it (a retried provision); a
 * number held by a different hub is a 409.
 */
export async function recordProvisionedNumber(
  db: Executor,
  hubId: string,
  rawNumber: string,
  providerConfigId: string | null,
): Promise<void> {
  const number = requireE164(rawNumber)
  const [existing] = await db.select().from(hubNumbers).where(eq(hubNumbers.number, number)).limit(1)
  if (existing) {
    if (existing.hubId !== hubId) throw numberTakenError()
    return
  }
  await insertOne(db, hubId, number, 'provisioned', 'hub', providerConfigId)
}

/**
 * The number row a dialled number resolves to, or null. `rawNumber` is
 * normalised first. A `hub`-scope number resolves only for a call delivered
 * through that hub's own provider account (`deliveredByHub`): a call the
 * platform account delivered can reach only numbers instance authority set.
 */
export async function findRoutableNumber(
  db: Executor,
  rawNumber: string,
  deliveredByHub: string | undefined,
): Promise<HubNumber | null> {
  const number = normalizeE164(rawNumber)
  if (!number) return null
  const [row] = await db.select().from(hubNumbers).where(eq(hubNumbers.number, number)).limit(1)
  if (!row) return null
  if (row.scope === 'hub' && row.hubId !== deliveredByHub) return null
  return fromRow(row)
}
