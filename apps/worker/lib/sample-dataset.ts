/**
 * The fixed sample dataset — hand-authored, obviously fictional.
 *
 * Everything here is invented: people are named "Example"/"Sample"/"Placeholder",
 * phone numbers sit in the reserved fictional 555-01xx range, and note text is
 * generic hotline content with no real-world identifiers. This file is plain
 * data (no crypto, no I/O); `services/sample-seeder.ts` encrypts and stores it.
 *
 * This is a TEST affordance, not a product mode. It was written for a public
 * demo instance; #1604 retired the demo product (the only two deployment shapes
 * are the secure hosted one and the self-hosted one) and kept the dataset,
 * because a deployed test instance still needs realistic seeded data to
 * exercise flows against. The one way to seed it is `POST /api/test-seed-sample`
 * on the secret-gated dev surface (lib/dev-surfaces.ts).
 *
 * Times are expressed as offsets from "now" (seed time) so the schedule and
 * call log always look current after each re-seed.
 */
import type { MessagingChannelType } from '@protocol/schemas/settings'

/** Stable hub identity so a re-seed replaces the previous sample hub instead of adding another. */
export const SAMPLE_HUB = {
  id: 'd3e0d3e0-0000-4000-8000-000000000001',
  name: 'Sample Hotline',
  slug: 'sample-hotline',
  description: 'Fictional sample hub. All people, numbers and notes are invented test data.',
} as const

/**
 * The sample cast's account metadata. Carries NO key material: the accounts'
 * Ed25519 signing seeds are generated per process by `lib/sample-identities.ts`
 * and exist nowhere else.
 *
 * This used to live in `packages/shared/demo-accounts.ts` so the login page's
 * demo account picker could render it. That picker — and the unauthenticated
 * `GET /api/config/demo/credentials` that fed it seeds — went with demo mode
 * (#1604), leaving the seeder as the only consumer, so the list moved here and
 * lost the two fields only the picker used (a `description` string and a
 * legacy secp256k1 handle).
 */
export interface SampleAccount {
  name: string
  roleIds: string[]
  phone: string
  spokenLanguages: string[]
}

export const SAMPLE_ACCOUNTS: readonly SampleAccount[] = [
  { name: 'Sample Admin', roleIds: ['role-super-admin'], phone: '+15551000001', spokenLanguages: ['en', 'es'] },
  { name: 'Maria Santos', roleIds: ['role-volunteer'], phone: '+15551000002', spokenLanguages: ['en', 'es', 'pt'] },
  { name: 'James Chen', roleIds: ['role-volunteer'], phone: '+15551000003', spokenLanguages: ['en', 'zh'] },
  { name: 'Fatima Al-Rashid', roleIds: ['role-volunteer'], phone: '+15551000004', spokenLanguages: ['en', 'ar'] },
  { name: 'Community Reporter', roleIds: ['role-reporter'], phone: '+15551000005', spokenLanguages: ['en'] },
]

/** Display names of the sample accounts the dataset is written around. */
export const SAMPLE_CAST = {
  admin: 'Sample Admin',
  maria: 'Maria Santos',
  james: 'James Chen',
} as const

type Volunteer = 'maria' | 'james'

// ─── Shifts ──────────────────────────────────────────────────────────────────
// Three 8-hour windows on all seven days cover the whole 24h clock (UTC), and
// James Chen is on every window — so the sample volunteer is on shift whenever
// someone looks. Maria overlaps the two daytime windows.

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

export const SAMPLE_SHIFTS: ReadonlyArray<{
  name: string
  startTime: string
  endTime: string
  days: number[]
  volunteers: Volunteer[]
}> = [
  { name: 'Overnight Line', startTime: '22:00', endTime: '06:00', days: ALL_DAYS, volunteers: ['james'] },
  { name: 'Morning Line', startTime: '06:00', endTime: '14:00', days: ALL_DAYS, volunteers: ['maria', 'james'] },
  { name: 'Afternoon Line', startTime: '14:00', endTime: '22:00', days: ALL_DAYS, volunteers: ['james', 'maria'] },
]

// ─── Calls + notes ───────────────────────────────────────────────────────────

export interface SampleCall {
  key: string
  hoursAgo: number
  durationSeconds: number
  callerLast4: string
  /** Who answered; null = unanswered (some of these left a voicemail). */
  answeredBy: Volunteer | null
  voicemail?: boolean
  /** Note the answering volunteer wrote about the call, if any. */
  note?: string
}

/** Twelve calls across the last fortnight, newest first. Eight carry a note. */
export const SAMPLE_CALLS: ReadonlyArray<SampleCall> = [
  {
    key: 'call-01', hoursAgo: 3, durationSeconds: 612, callerLast4: '0142', answeredBy: 'james',
    note: 'Caller has felt very isolated since moving to a new city. We talked through a simple evening routine and I shared the hub\'s peer-support group schedule. Caller said they would try the Thursday meetup.',
  },
  {
    key: 'call-02', hoursAgo: 19, durationSeconds: 348, callerLast4: '0177', answeredBy: 'maria',
    note: 'Asked where to find emergency food assistance nearby. Read out two community pantry listings from the resource sheet. Offered a follow-up call; caller declined, said this was enough for now.',
  },
  {
    key: 'call-03', hoursAgo: 41, durationSeconds: 0, callerLast4: '0119', answeredBy: null, voicemail: true,
  },
  {
    key: 'call-04', hoursAgo: 58, durationSeconds: 905, callerLast4: '0163', answeredBy: 'james',
    note: 'Long conversation about work stress and trouble sleeping. Caller was calm and engaged throughout. Walked through a breathing exercise together. Suggested speaking with a doctor about the sleep issue.',
  },
  {
    key: 'call-05', hoursAgo: 82, durationSeconds: 271, callerLast4: '0108', answeredBy: 'maria',
    note: 'Caller needed the number for a tenant legal-aid clinic. Provided it along with the clinic\'s opening hours. Call ended positively.',
  },
  {
    key: 'call-06', hoursAgo: 110, durationSeconds: 0, callerLast4: '0131', answeredBy: null,
  },
  {
    key: 'call-07', hoursAgo: 137, durationSeconds: 733, callerLast4: '0186', answeredBy: 'maria',
    note: 'Caller is caring for a family member and feels burned out. Listened, validated, and shared the caregiver respite line. Agreed a small goal: one hour off this weekend.',
  },
  {
    key: 'call-08', hoursAgo: 166, durationSeconds: 194, callerLast4: '0125', answeredBy: 'james',
  },
  {
    key: 'call-09', hoursAgo: 205, durationSeconds: 522, callerLast4: '0152', answeredBy: 'james',
    note: 'Caller wanted to talk after a rough day. No safety concerns raised. Ended the call feeling lighter and thanked the line.',
  },
  {
    key: 'call-10', hoursAgo: 244, durationSeconds: 388, callerLast4: '0197', answeredBy: 'maria',
    note: 'Question about translation help for a benefits form. Explained that our Spanish and Portuguese volunteers can support on a scheduled call, and booked a slot with the coordinator.',
  },
  {
    key: 'call-11', hoursAgo: 290, durationSeconds: 0, callerLast4: '0114', answeredBy: null, voicemail: true,
  },
  {
    key: 'call-12', hoursAgo: 318, durationSeconds: 466, callerLast4: '0139', answeredBy: 'james',
    note: 'First-time caller, unsure what the line is for. Explained how it works and what we can and cannot do. Caller said they would call back if needed.',
  },
]

// ─── Contacts ────────────────────────────────────────────────────────────────

export type SampleContactType = 'individual' | 'organization' | 'legal_resource' | 'service_provider'

export interface SampleContact {
  key: string
  displayName: string
  contactType: SampleContactType
  tags: string[]
  /** Fictional phone number (reserved 555-01xx range) used only as a blind-index identifier. */
  phone: string
}

export const SAMPLE_CONTACTS: ReadonlyArray<SampleContact> = [
  { key: 'contact-1', displayName: 'Riley Example', contactType: 'individual', tags: ['follow-up'], phone: '+15555550142' },
  { key: 'contact-2', displayName: 'Sam Sample', contactType: 'individual', tags: ['caregiver'], phone: '+15555550177' },
  { key: 'contact-3', displayName: 'Jordan Placeholder', contactType: 'individual', tags: ['regular-caller'], phone: '+15555550163' },
  { key: 'contact-4', displayName: 'Taylor Testcase', contactType: 'individual', tags: [], phone: '+15555550108' },
  { key: 'contact-5', displayName: 'Example Tenants Legal Clinic', contactType: 'legal_resource', tags: ['housing', 'referral'], phone: '+15555550111' },
  { key: 'contact-6', displayName: 'Sample Community Pantry', contactType: 'service_provider', tags: ['food', 'referral'], phone: '+15555550122' },
  { key: 'contact-7', displayName: 'Placeholder Caregiver Respite Line', contactType: 'service_provider', tags: ['respite', 'referral'], phone: '+15555550133' },
  { key: 'contact-8', displayName: 'Sample Peer Support Collective', contactType: 'organization', tags: ['peer-support'], phone: '+15555550144' },
]

// ─── Cases ───────────────────────────────────────────────────────────────────

export const SAMPLE_ENTITY_TYPE = {
  name: 'support_case',
  label: 'Support Case',
  labelPlural: 'Support Cases',
  description: 'Ongoing follow-up for a caller who needs more than one call.',
  category: 'case' as const,
  color: '#3b82f6',
  statuses: [
    { value: 'open', label: 'Open', color: '#f59e0b', order: 1 },
    { value: 'in_progress', label: 'In Progress', color: '#3b82f6', order: 2 },
    { value: 'resolved', label: 'Resolved', color: '#22c55e', order: 3, isClosed: true },
  ],
  defaultStatus: 'open',
  closedStatuses: ['resolved'],
  numberPrefix: 'SAMPLE',
  numberingEnabled: true,
} as const

export interface SampleCase {
  key: string
  title: string
  description: string
  status: 'open' | 'in_progress' | 'resolved'
  assignedTo: Volunteer
  /** Keys of SAMPLE_CONTACTS linked to this case. */
  contacts: string[]
  /** Timeline, oldest first. `noteOfCall` links the note written on that call. */
  timeline: ReadonlyArray<
    | { kind: 'comment'; hoursAgo: number; author: Volunteer; text: string }
    | { kind: 'status'; hoursAgo: number; author: Volunteer; from: 'open' | 'in_progress'; to: 'in_progress' | 'resolved' }
    | { kind: 'note'; hoursAgo: number; author: Volunteer; noteOfCall: string }
  >
}

export const SAMPLE_CASES: ReadonlyArray<SampleCase> = [
  {
    key: 'case-1',
    title: 'Caregiver support follow-up',
    description: 'Caller is caring for a family member and asked for regular check-ins and respite options.',
    status: 'in_progress',
    assignedTo: 'maria',
    contacts: ['contact-2', 'contact-7'],
    timeline: [
      { kind: 'note', hoursAgo: 136, author: 'maria', noteOfCall: 'call-07' },
      { kind: 'comment', hoursAgo: 120, author: 'maria', text: 'Opened this case so the team can keep the follow-up consistent. Respite line details shared with the caller.' },
      { kind: 'status', hoursAgo: 96, author: 'maria', from: 'open', to: 'in_progress' },
      { kind: 'comment', hoursAgo: 30, author: 'maria', text: 'Check-in call planned for early next week. Caller reported they managed one hour off.' },
    ],
  },
  {
    key: 'case-2',
    title: 'Tenant legal-aid referral',
    description: 'Referral to a tenant legal-aid clinic; confirm the caller reached the clinic.',
    status: 'resolved',
    assignedTo: 'james',
    contacts: ['contact-4', 'contact-5'],
    timeline: [
      { kind: 'note', hoursAgo: 81, author: 'maria', noteOfCall: 'call-05' },
      { kind: 'comment', hoursAgo: 70, author: 'james', text: 'Picked this up to confirm the referral landed. Will call the clinic contact tomorrow.' },
      { kind: 'status', hoursAgo: 46, author: 'james', from: 'open', to: 'resolved' },
    ],
  },
]

// ─── Conversations (one per configured messaging channel) ───────────────────

export interface SampleConversation {
  /** Fictional sender number/handle used to derive the blind-index hash. */
  sender: string
  last4: string
  assignedTo: Volunteer
  messages: ReadonlyArray<{ direction: 'inbound' | 'outbound'; text: string }>
}

export const SAMPLE_CONVERSATIONS: Record<MessagingChannelType, SampleConversation> = {
  sms: {
    sender: '+15555550151', last4: '0151', assignedTo: 'maria',
    messages: [
      { direction: 'inbound', text: 'Hi, is this the support line? I saw the number on a flyer.' },
      { direction: 'outbound', text: 'Hello, yes it is. Thanks for reaching out. What would you like to talk about?' },
      { direction: 'inbound', text: 'Mostly just feeling overwhelmed this week. Not sure where to start.' },
      { direction: 'outbound', text: 'That sounds like a lot. We can take it one piece at a time. What feels heaviest right now?' },
    ],
  },
  whatsapp: {
    sender: '+15555550152', last4: '0152', assignedTo: 'james',
    messages: [
      { direction: 'inbound', text: 'Hello! Do you have someone who speaks Portuguese?' },
      { direction: 'outbound', text: 'Hello, yes. I will connect you with a Portuguese-speaking volunteer. One moment please.' },
    ],
  },
  signal: {
    sender: '+15555550153', last4: '0153', assignedTo: 'james',
    messages: [
      { direction: 'inbound', text: 'Is this chat private? I would rather not use a regular phone call.' },
      { direction: 'outbound', text: 'Messages here are end-to-end encrypted and only the volunteer helping you and the admins can read them.' },
      { direction: 'inbound', text: 'Thank you, that helps. Can we talk about a difficult situation at home?' },
    ],
  },
  telegram: {
    sender: '@sample_contact', last4: '0154', assignedTo: 'maria',
    messages: [
      { direction: 'inbound', text: 'Hey, do you have a list of local support groups?' },
      { direction: 'outbound', text: 'We do! I will send you the current schedule. Is there a particular topic you are looking for?' },
    ],
  },
  rcs: {
    sender: '+15555550155', last4: '0155', assignedTo: 'maria',
    messages: [
      { direction: 'inbound', text: 'Can I get a call back tomorrow afternoon?' },
      { direction: 'outbound', text: 'Of course. I have noted tomorrow afternoon. What is the best number to reach you on?' },
    ],
  },
}

// ─── Audit trail ─────────────────────────────────────────────────────────────

/** Volunteer actions appear in the audit log with the real action names the app uses. */
export const SAMPLE_ADMIN_AUDIT_ACTIONS: ReadonlyArray<{ hoursAgo: number; action: string; details: Record<string, unknown> }> = [
  { hoursAgo: 330, action: 'userAdded', details: { name: 'Maria Santos' } },
  { hoursAgo: 330, action: 'userAdded', details: { name: 'James Chen' } },
  { hoursAgo: 328, action: 'shiftCreated', details: { name: 'Morning Line' } },
  { hoursAgo: 328, action: 'shiftCreated', details: { name: 'Afternoon Line' } },
  { hoursAgo: 328, action: 'shiftCreated', details: { name: 'Overnight Line' } },
]
