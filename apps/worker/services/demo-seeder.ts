/**
 * Demo dataset seeder and reset.
 *
 * `seedDemoDataset` writes the fixed fictional dataset from `lib/demo-dataset.ts`
 * into one hub. It is idempotent: it first deletes the demo hub (a cascade over
 * every hub-scoped table), then rebuilds it, so row counts are the same after
 * one run or two. All E2EE content is sealed to the demo accounts' keys through
 * `lib/demo-crypto.ts` using labels from crypto-labels.
 *
 * `resetDemoData` is the full wipe used by the demo-reset endpoint: it clears
 * every table the old dev-only reset cleared, restores the default settings and
 * demo accounts, then seeds.
 *
 * Both need the demo identities, which only a development server can produce
 * (`lib/demo-identities.ts`), so both refuse everywhere else before writing.
 */
import type { Services } from './index'
import { ServiceError } from './settings'
import {
  DEMO_ADMIN_AUDIT_ACTIONS,
  DEMO_CALLS,
  DEMO_CASES,
  DEMO_CAST,
  DEMO_CONTACTS,
  DEMO_CONVERSATIONS,
  DEMO_ENTITY_TYPE,
  DEMO_HUB,
  DEMO_SHIFTS,
} from '../lib/demo-dataset'
import { demoReader, sealForReaders, type DemoReader } from '../lib/demo-crypto'
import { demoIdentities, type DemoIdentity } from '../lib/demo-identities'
import type { DevSurfacesEnv } from '../lib/dev-surfaces'
import { encryptContactIdentifier, hashPhone } from '../lib/crypto'
import { LABEL_CALL_META, LABEL_MESSAGE, LABEL_NOTE_KEY } from '@shared/crypto-labels'
import type { Hub } from '@shared/types'
import type { MessagingChannelType } from '@protocol/schemas/settings'

const HOUR_MS = 3_600_000

export interface DemoSeedEnv extends DevSurfacesEnv {
  ENVIRONMENT: string
  HMAC_SECRET: string
  TWILIO_ACCOUNT_SID?: string
  TWILIO_AUTH_TOKEN?: string
  TWILIO_PHONE_NUMBER?: string
}

export interface DemoSeedSummary {
  hubId: string
  shifts: number
  calls: number
  notes: number
  contacts: number
  cases: number
  interactions: number
  conversations: number
  messages: number
  auditEntries: number
}

type Cast = { admin: DemoReader; maria: DemoReader; james: DemoReader }

function loadCast(accounts: readonly DemoIdentity[]): Cast {
  const byName = (name: string): DemoReader => {
    const identity = accounts.find(a => a.name === name)
    if (!identity) throw new Error(`Demo account "${name}" missing from DEMO_ACCOUNTS`)
    return demoReader(identity)
  }
  return { admin: byName(DEMO_CAST.admin), maria: byName(DEMO_CAST.maria), james: byName(DEMO_CAST.james) }
}

function contactLookupKey(phone: string): string {
  return `phone:${Buffer.from(phone).toString('base64').slice(0, 16)}`
}

function trigrams(name: string): string[] {
  const normalized = name.trim().toLowerCase()
  const out: string[] = []
  for (let i = 0; i <= normalized.length - 3; i++) out.push(normalized.slice(i, i + 3))
  return out
}

/**
 * Seed the fixed demo dataset into the demo hub, replacing any previous copy.
 * The five demo accounts must already exist (`identity.ensureDemoAccounts`).
 */
export async function seedDemoDataset(
  services: Services,
  env: DemoSeedEnv,
  now: Date = new Date(),
): Promise<DemoSeedSummary> {
  const accounts = demoIdentities(env)
  for (const account of accounts) {
    const user = await services.identity.getUserInternal(account.pubkey)
    if (!user) {
      throw new ServiceError(409, `Demo account ${account.name} does not exist — initialise demo accounts before seeding`)
    }
  }
  const cast = loadCast(accounts)
  const hubId = DEMO_HUB.id
  const ago = (hours: number): Date => new Date(now.getTime() - hours * HOUR_MS)
  const reader = (who: 'maria' | 'james'): DemoReader => cast[who]
  const summary: DemoSeedSummary = {
    hubId, shifts: 0, calls: 0, notes: 0, contacts: 0, cases: 0,
    interactions: 0, conversations: 0, messages: 0, auditEntries: 0,
  }

  // ── Replace: dropping the hub cascades through every hub-scoped table ─────
  await services.settings.ensureInit({ ENVIRONMENT: env.ENVIRONMENT })
  await services.settings.purgeHub(hubId)
  // purgeHub also removes users that belonged only to that hub — put the demo accounts back
  await services.identity.ensureDemoAccounts(accounts)

  // ── Hub + membership ──────────────────────────────────────────────────────
  const hub: Hub = {
    id: hubId,
    name: DEMO_HUB.name,
    slug: DEMO_HUB.slug,
    description: DEMO_HUB.description,
    status: 'active',
    createdBy: cast.admin.pubkey,
    createdAt: ago(24 * 14).toISOString(),
    updatedAt: now.toISOString(),
  }
  await services.settings.createHub(hub)
  for (const account of accounts) {
    const roleIds = account.roleIds.includes('role-super-admin') ? ['role-hub-admin'] : account.roleIds
    await services.identity.setHubRole({ pubkey: account.pubkey, hubId, roleIds })
  }
  await services.settings.setCaseManagementEnabled({ enabled: true }, hubId)

  // ── Shifts: a recurring 7-day schedule ────────────────────────────────────
  for (const shift of DEMO_SHIFTS) {
    await services.shifts.create(hubId, {
      encryptedName: shift.name,
      startTime: shift.startTime,
      endTime: shift.endTime,
      days: shift.days,
      userPubkeys: shift.volunteers.map(v => reader(v).pubkey),
    })
    summary.shifts++
  }

  // ── Calls and the notes written about them ───────────────────────────────
  const noteIdByCall = new Map<string, { id: string; author: 'maria' | 'james' }>()
  const callEvents: Array<{ at: Date; action: string; actor: string; details: Record<string, unknown> }> = []

  for (const call of DEMO_CALLS) {
    const startedAt = ago(call.hoursAgo)
    const callId = `demo-${call.key}`
    const answerer = call.answeredBy ? reader(call.answeredBy) : null
    const meta = sealForReaders(
      JSON.stringify({ answeredBy: answerer?.pubkey ?? null, callerNumber: `+1555555${call.callerLast4}` }),
      answerer ? [cast.admin, answerer] : [cast.admin],
      LABEL_CALL_META,
    )
    await services.calls.recordHistoricalCall(hubId, {
      callId,
      callerLast4: call.callerLast4,
      startedAt,
      durationSeconds: call.durationSeconds,
      answeredBy: answerer?.pubkey ?? null,
      status: answerer ? 'completed' : 'unanswered',
      hasVoicemail: call.voicemail ?? false,
      encryptedContent: meta.encryptedContent,
      adminEnvelopes: meta.envelopes,
    })
    summary.calls++

    if (answerer && call.answeredBy) {
      callEvents.push({ at: startedAt, action: 'callAnswered', actor: answerer.pubkey, details: { callId } })
    } else {
      callEvents.push({ at: startedAt, action: 'callMissed', actor: 'system', details: { callId } })
    }

    if (answerer && call.answeredBy && call.note) {
      const noteAt = new Date(startedAt.getTime() + (call.durationSeconds + 90) * 1000)
      const sealed = sealForReaders(JSON.stringify({ text: call.note }), [answerer, cast.admin], LABEL_NOTE_KEY)
      const [authorEnvelope, adminEnvelope] = sealed.envelopes
      const note = await services.records.createNote({
        hubId,
        authorPubkey: answerer.pubkey,
        callId,
        encryptedContent: sealed.encryptedContent,
        authorEnvelope: { enc: authorEnvelope.enc, ct: authorEnvelope.ct },
        adminEnvelopes: [adminEnvelope],
        createdAt: noteAt,
      })
      noteIdByCall.set(call.key, { id: note.id, author: call.answeredBy })
      summary.notes++
      callEvents.push({ at: noteAt, action: 'noteCreated', actor: answerer.pubkey, details: { callId } })
    }
  }

  // ── Contacts ──────────────────────────────────────────────────────────────
  const contactReaders = [cast.admin, cast.maria, cast.james]
  const contactIds = new Map<string, string>()
  for (const contact of DEMO_CONTACTS) {
    const sealed = sealForReaders(
      JSON.stringify({ displayName: contact.displayName, contactType: contact.contactType, tags: contact.tags }),
      contactReaders,
      LABEL_MESSAGE,
    )
    const row = await services.contacts.create({
      hubId,
      identifierHashes: [contactLookupKey(contact.phone)],
      nameHash: Buffer.from(contact.displayName.trim().toLowerCase()).toString('base64').slice(0, 32),
      trigramTokens: trigrams(contact.displayName),
      encryptedSummary: sealed.encryptedContent,
      summaryEnvelopes: sealed.envelopes,
      contactTypeHash: contact.contactType,
      tagHashes: [],
      blindIndexes: {},
    })
    contactIds.set(contact.key, row.id)
    summary.contacts++
  }

  // ── Cases with a timeline ─────────────────────────────────────────────────
  const entityType = await services.settings.createEntityType({
    ...DEMO_ENTITY_TYPE,
    statuses: [...DEMO_ENTITY_TYPE.statuses],
    closedStatuses: [...DEMO_ENTITY_TYPE.closedStatuses],
    fields: [],
    hubId,
  })
  const statusLabel = (value: string) => DEMO_ENTITY_TYPE.statuses.find(s => s.value === value)?.label ?? value

  for (const demoCase of DEMO_CASES) {
    const assignee = reader(demoCase.assignedTo)
    const sealed = sealForReaders(
      JSON.stringify({ title: demoCase.title, description: demoCase.description, status: statusLabel(demoCase.status) }),
      [cast.admin, cast.maria, cast.james],
      LABEL_MESSAGE,
    )
    const { number: caseNumber } = await services.settings.generateCaseNumber({
      prefix: DEMO_ENTITY_TYPE.numberPrefix,
      hubId,
    })
    const record = await services.cases.create({
      hubId,
      createdBy: assignee.pubkey,
      caseNumber,
      entityTypeId: entityType.id,
      statusHash: demoCase.status,
      assignedTo: [assignee.pubkey],
      blindIndexes: {},
      encryptedSummary: sealed.encryptedContent,
      summaryEnvelopes: sealed.envelopes,
      contactLinks: demoCase.contacts.map(key => {
        const contactId = contactIds.get(key)
        const contact = DEMO_CONTACTS.find(c => c.key === key)
        if (!contactId || !contact) throw new Error(`Demo case "${demoCase.key}" links unknown contact "${key}"`)
        return { contactId, role: contact.contactType === 'individual' ? 'client' : 'referral' }
      }),
    })
    summary.cases++

    for (const step of demoCase.timeline) {
      const author = reader(step.author)
      const createdAt = ago(step.hoursAgo)
      if (step.kind === 'comment') {
        const comment = sealForReaders(JSON.stringify({ text: step.text }), [cast.admin, cast.maria, cast.james], LABEL_MESSAGE)
        await services.cases.createInteraction(record.id, author.pubkey, {
          interactionType: 'comment',
          encryptedContent: comment.encryptedContent,
          contentEnvelopes: comment.envelopes,
          interactionTypeHash: 'comment',
        }, { createdAt })
      } else if (step.kind === 'status') {
        await services.cases.createInteraction(record.id, author.pubkey, {
          interactionType: 'status_change',
          interactionTypeHash: 'status_change',
          previousStatusHash: step.from,
          newStatusHash: step.to,
        }, { createdAt })
      } else {
        const linked = noteIdByCall.get(step.noteOfCall)
        if (!linked) throw new Error(`Demo case "${demoCase.key}" links note of call "${step.noteOfCall}" which has no note`)
        await services.cases.createInteraction(record.id, author.pubkey, {
          interactionType: 'note',
          sourceId: linked.id,
          interactionTypeHash: 'note',
        }, { createdAt })
      }
      summary.interactions++
    }
    if (demoCase.status === 'resolved') {
      await services.cases.update(record.id, { closedAt: ago(demoCase.timeline.at(-1)?.hoursAgo ?? 0).toISOString() })
    }
  }

  // ── One conversation per configured messaging channel ────────────────────
  const enabled = await services.settings.getEnabledChannels(env)
  const channels = (Object.keys(DEMO_CONVERSATIONS) as MessagingChannelType[]).filter(c => enabled[c])
  for (const channel of channels) {
    const demo = DEMO_CONVERSATIONS[channel]
    const assignee = reader(demo.assignedTo)
    const conversation = await services.conversations.create({
      hubId,
      channelType: channel,
      contactIdentifierHash: hashPhone(demo.sender, env.HMAC_SECRET),
      contactLast4: demo.last4,
      assignedTo: assignee.pubkey,
      status: 'active',
    })
    await services.conversations.setContactIdentifier(
      conversation.id,
      encryptContactIdentifier(demo.sender, env.HMAC_SECRET),
    )
    summary.conversations++
    for (const message of demo.messages) {
      const sealed = sealForReaders(message.text, [cast.admin, assignee], LABEL_MESSAGE)
      await services.conversations.addMessage({
        conversationId: conversation.id,
        direction: message.direction,
        authorPubkey: message.direction === 'inbound' ? 'system:inbound' : assignee.pubkey,
        encryptedContent: sealed.encryptedContent,
        readerEnvelopes: sealed.envelopes,
        status: message.direction === 'outbound' ? 'delivered' : 'sent',
      })
      summary.messages++
    }
  }

  // ── Audit trail (hash-chained, appended oldest → newest) ─────────────────
  const auditEvents = [
    ...DEMO_ADMIN_AUDIT_ACTIONS.map(e => ({ at: ago(e.hoursAgo), action: e.action, actor: cast.admin.pubkey, details: e.details })),
    ...callEvents,
  ].sort((a, b) => a.at.getTime() - b.at.getTime())
  let previousMs = 0
  for (const event of auditEvents) {
    // The chain head is ordered by timestamp — keep every entry strictly later than the last
    const atMs = Math.max(event.at.getTime(), previousMs + 1)
    previousMs = atMs
    await services.audit.log(event.action, event.actor, event.details, hubId, new Date(atMs))
    summary.auditEntries++
  }

  return summary
}

export interface DemoResetEnv extends DemoSeedEnv {
  DEMO_MODE?: string
  DEMO_MODE_CONFIRM?: string
  ADMIN_PUBKEY?: string
}

/**
 * Wipe every table the demo instance writes to, restore defaults and the demo
 * accounts, then seed the fixed dataset. Callers must have passed
 * `demoResetRefusal` first; the per-service resets re-check the demo flags, and
 * the demo identities are resolved before anything is wiped.
 */
export async function resetDemoData(
  services: Services,
  env: DemoResetEnv,
  now: Date = new Date(),
): Promise<DemoSeedSummary> {
  const accounts = demoIdentities(env)
  const resetEnv = {
    DEMO_MODE: env.DEMO_MODE,
    DEMO_MODE_CONFIRM: env.DEMO_MODE_CONFIRM,
    ENVIRONMENT: env.ENVIRONMENT,
  }

  // Hub-scoped rows are not reachable through the global resets below — drop each hub first.
  const { hubs } = await services.settings.getHubs()
  for (const hub of hubs) await services.settings.purgeHub(hub.id)

  await services.audit.reset()
  await services.identity.reset(env.DEMO_MODE === 'true', env.ENVIRONMENT, env.DEMO_MODE_CONFIRM)
  // Settings before identity re-init: the roles table must exist before any user resolves permissions.
  await services.settings.reset(resetEnv)
  await services.settings.ensureInit(resetEnv)
  await services.identity.ensureInit(env.ADMIN_PUBKEY)
  await services.identity.ensureDemoAccounts(accounts)
  await services.records.reset()
  await services.shifts.reset('')
  await services.calls.reset('')
  await services.conversations.reset()
  await services.blasts.reset()
  await services.contacts.reset(resetEnv)
  await services.cases.reset(resetEnv)

  return seedDemoDataset(services, env, now)
}
