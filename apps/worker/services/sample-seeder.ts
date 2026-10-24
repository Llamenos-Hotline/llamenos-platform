/**
 * Sample dataset seeder.
 *
 * `seedSampleDataset` writes the fixed fictional dataset from
 * `lib/sample-dataset.ts` into one hub. It is idempotent: it first deletes the
 * sample hub (a cascade over every hub-scoped table), then rebuilds it, so row
 * counts are the same after one run or two. All E2EE content is sealed to the
 * sample accounts' keys through `lib/sample-crypto.ts` using labels from
 * crypto-labels.
 *
 * It needs the sample identities, which only a server with the `/api/test-*`
 * surface enabled can produce (`lib/sample-identities.ts`), so it refuses
 * everywhere else before writing.
 *
 * A second entry point, `resetDemoData`, used to wipe EVERY table and re-seed
 * for the demo product's `POST /api/demo/reset`. That endpoint went with demo
 * mode (#1604); the same effect is `POST /api/test-reset` followed by
 * `POST /api/test-seed-sample`, both on the one secret-gated dev surface, so
 * there is no second reset path to keep in step with the first.
 */
import type { Services } from './index'
import { ServiceError } from './settings'
import {
  SAMPLE_ADMIN_AUDIT_ACTIONS,
  SAMPLE_CALLS,
  SAMPLE_CASES,
  SAMPLE_CAST,
  SAMPLE_CONTACTS,
  SAMPLE_CONVERSATIONS,
  SAMPLE_ENTITY_TYPE,
  SAMPLE_HUB,
  SAMPLE_SHIFTS,
} from '../lib/sample-dataset'
import { sampleReader, sealForReaders, type SampleReader } from '../lib/sample-crypto'
import { sampleIdentities, type SampleIdentity } from '../lib/sample-identities'
import type { DevSurfacesEnv } from '../lib/dev-surfaces'
import { encryptContactIdentifier, hashPhone } from '../lib/crypto'
import { LABEL_CALL_META, LABEL_MESSAGE, LABEL_NOTE_KEY } from '@shared/crypto-labels'
import type { Hub } from '@shared/types'
import type { MessagingChannelType } from '@protocol/schemas/settings'

const HOUR_MS = 3_600_000

export interface SampleSeedEnv extends DevSurfacesEnv {
  ENVIRONMENT: string
  HMAC_SECRET: string
  TWILIO_ACCOUNT_SID?: string
  TWILIO_AUTH_TOKEN?: string
  TWILIO_PHONE_NUMBER?: string
}

export interface SampleSeedSummary {
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

type Cast = { admin: SampleReader; maria: SampleReader; james: SampleReader }

function loadCast(accounts: readonly SampleIdentity[]): Cast {
  const byName = (name: string): SampleReader => {
    const identity = accounts.find(a => a.name === name)
    if (!identity) throw new Error(`Sample account "${name}" missing from SAMPLE_ACCOUNTS`)
    return sampleReader(identity)
  }
  return { admin: byName(SAMPLE_CAST.admin), maria: byName(SAMPLE_CAST.maria), james: byName(SAMPLE_CAST.james) }
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
 * Seed the fixed sample dataset into the sample hub, replacing any previous copy.
 * The five sample accounts must already exist (`identity.ensureSampleAccounts`).
 */
export async function seedSampleDataset(
  services: Services,
  env: SampleSeedEnv,
  now: Date = new Date(),
): Promise<SampleSeedSummary> {
  const accounts = sampleIdentities(env)
  for (const account of accounts) {
    const user = await services.identity.getUserInternal(account.pubkey)
    if (!user) {
      throw new ServiceError(409, `Sample account ${account.name} does not exist — initialise sample accounts before seeding`)
    }
  }
  const cast = loadCast(accounts)
  const hubId = SAMPLE_HUB.id
  const ago = (hours: number): Date => new Date(now.getTime() - hours * HOUR_MS)
  const reader = (who: 'maria' | 'james'): SampleReader => cast[who]
  const summary: SampleSeedSummary = {
    hubId, shifts: 0, calls: 0, notes: 0, contacts: 0, cases: 0,
    interactions: 0, conversations: 0, messages: 0, auditEntries: 0,
  }

  // ── Replace: dropping the hub cascades through every hub-scoped table ─────
  await services.settings.ensureInit({ ENVIRONMENT: env.ENVIRONMENT })
  await services.settings.purgeHub(hubId)
  // purgeHub also removes users that belonged only to that hub — put the sample accounts back
  await services.identity.ensureSampleAccounts(accounts)

  // ── Hub + membership ──────────────────────────────────────────────────────
  const hub: Hub = {
    id: hubId,
    name: SAMPLE_HUB.name,
    slug: SAMPLE_HUB.slug,
    description: SAMPLE_HUB.description,
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
  for (const shift of SAMPLE_SHIFTS) {
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

  for (const call of SAMPLE_CALLS) {
    const startedAt = ago(call.hoursAgo)
    const callId = `sample-${call.key}`
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
  for (const contact of SAMPLE_CONTACTS) {
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
    ...SAMPLE_ENTITY_TYPE,
    statuses: [...SAMPLE_ENTITY_TYPE.statuses],
    closedStatuses: [...SAMPLE_ENTITY_TYPE.closedStatuses],
    fields: [],
    hubId,
  })
  const statusLabel = (value: string) => SAMPLE_ENTITY_TYPE.statuses.find(s => s.value === value)?.label ?? value

  for (const sampleCase of SAMPLE_CASES) {
    const assignee = reader(sampleCase.assignedTo)
    const sealed = sealForReaders(
      JSON.stringify({ title: sampleCase.title, description: sampleCase.description, status: statusLabel(sampleCase.status) }),
      [cast.admin, cast.maria, cast.james],
      LABEL_MESSAGE,
    )
    const { number: caseNumber } = await services.settings.generateCaseNumber({
      prefix: SAMPLE_ENTITY_TYPE.numberPrefix,
      hubId,
    })
    const record = await services.cases.create({
      hubId,
      createdBy: assignee.pubkey,
      caseNumber,
      entityTypeId: entityType.id,
      statusHash: sampleCase.status,
      assignedTo: [assignee.pubkey],
      blindIndexes: {},
      encryptedSummary: sealed.encryptedContent,
      summaryEnvelopes: sealed.envelopes,
      contactLinks: sampleCase.contacts.map(key => {
        const contactId = contactIds.get(key)
        const contact = SAMPLE_CONTACTS.find(c => c.key === key)
        if (!contactId || !contact) throw new Error(`Sample case "${sampleCase.key}" links unknown contact "${key}"`)
        return { contactId, role: contact.contactType === 'individual' ? 'client' : 'referral' }
      }),
    })
    summary.cases++

    for (const step of sampleCase.timeline) {
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
        if (!linked) throw new Error(`Sample case "${sampleCase.key}" links note of call "${step.noteOfCall}" which has no note`)
        await services.cases.createInteraction(record.id, author.pubkey, {
          interactionType: 'note',
          sourceId: linked.id,
          interactionTypeHash: 'note',
        }, { createdAt })
      }
      summary.interactions++
    }
    if (sampleCase.status === 'resolved') {
      await services.cases.update(record.id, { closedAt: ago(sampleCase.timeline.at(-1)?.hoursAgo ?? 0).toISOString() })
    }
  }

  // ── One conversation per configured messaging channel ────────────────────
  const enabled = await services.settings.getEnabledChannels(env)
  const channels = (Object.keys(SAMPLE_CONVERSATIONS) as MessagingChannelType[]).filter(c => enabled[c])
  for (const channel of channels) {
    const sample = SAMPLE_CONVERSATIONS[channel]
    const assignee = reader(sample.assignedTo)
    const conversation = await services.conversations.create({
      hubId,
      channelType: channel,
      contactIdentifierHash: hashPhone(sample.sender, env.HMAC_SECRET),
      contactLast4: sample.last4,
      assignedTo: assignee.pubkey,
      status: 'active',
    })
    await services.conversations.setContactIdentifier(
      conversation.id,
      encryptContactIdentifier(sample.sender, env.HMAC_SECRET),
    )
    summary.conversations++
    for (const message of sample.messages) {
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
    ...SAMPLE_ADMIN_AUDIT_ACTIONS.map(e => ({ at: ago(e.hoursAgo), action: e.action, actor: cast.admin.pubkey, details: e.details })),
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
