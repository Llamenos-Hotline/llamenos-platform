/**
 * Step definitions for hub-files.feature (#2462): a file belongs to a hub, and
 * uploads are authorised by the caller's role in that hub.
 *
 * Members are admitted the way a real one is — an invite redeemed with their
 * own key — so their only grant is a hub role and their global roles are empty.
 * That is the user the unscoped upload route refused.
 */
import { expect } from '@playwright/test'
import { Before, Given, When, Then, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  ADMIN_SEED,
  apiGet,
  apiPost,
  createHubViaApi,
  downloadFileViaApi,
  generateTestKeypair,
  redeemInviteViaApi,
  uploadFileViaApi,
  type UploadedTestFile,
} from '../../api-helpers'
import { hpkeRecipientForSeed, unwrapKey, decryptContent } from '../../crypto-helpers'
import { bytesToHex } from '@shared/encoding'
import { LABEL_FILE_KEY } from '@shared/crypto-labels'
import type { FileEnvelopesResponse } from '@protocol/schemas'

interface HubFilesState {
  volunteerSeed?: string
  hubAdminSeed?: string
  otherHubId?: string
  file?: UploadedTestFile
  lastStatus?: number
}

const KEY = 'hubFiles'

Before({ tags: '@hub-files' }, async ({ world }) => {
  setState<HubFilesState>(world, KEY, {})
})

function st(world: Record<string, unknown>): HubFilesState {
  return getState<HubFilesState>(world, KEY)
}

function hubOf(world: Record<string, unknown>): string {
  return getScenarioState(world).hubId
}

/** Redeem an invite into the scenario hub with `roleIds`; returns the member's seed. */
async function memberByInvite(
  request: import('@playwright/test').APIRequestContext,
  hubId: string,
  roleIds: string[],
): Promise<string> {
  const invite = await apiPost<{ invite?: { code: string } }>(request, '/invites', {
    name: `hub-files-${roleIds[0]}`, phone: '', roleIds, hubId,
  })
  expect(invite.status).toBe(201)
  const member = generateTestKeypair()
  const redeemed = await redeemInviteViaApi(request, invite.data!.invite!.code, member.seedHex)
  expect(redeemed.status).toBe(200)
  return member.seedHex
}

function cmsRecordId(world: Record<string, unknown>): string {
  const record = getState<{ lastRecord?: Record<string, unknown> }>(world, 'cms').lastRecord
  if (typeof record?.id !== 'string') throw new Error('No record in cms state')
  return record.id
}

Given('a volunteer who joined the hub by invite', async ({ request, world }) => {
  st(world).volunteerSeed = await memberByInvite(request, hubOf(world), ['role-volunteer'])
})

Given('a hub admin who joined the hub by invite', async ({ request, world }) => {
  st(world).hubAdminSeed = await memberByInvite(request, hubOf(world), ['role-hub-admin'])
})

Given('another hub exists', async ({ request, world }) => {
  st(world).otherHubId = await createHubViaApi(request, `bdd-files-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
})

When('the volunteer uploads an entity field file to the hub', async ({ request, world }) => {
  const s = st(world)
  s.file = await uploadFileViaApi(request, { hubId: hubOf(world), owner: { kind: 'entity_field' } }, s.volunteerSeed!)
})

Then('the upload succeeds as a file of the hub', async ({ request, world }) => {
  const s = st(world)
  expect(s.file!.status).toBe('complete')
  // Readable through its own hub by its uploader…
  const env = await apiGet(request, `/hubs/${hubOf(world)}/files/${s.file!.fileId}/envelopes`, s.volunteerSeed!)
  expect(env.status).toBe(200)
})

Then('the volunteer can download the file and open it with their envelope', async ({ request, world }) => {
  const s = st(world)
  const hubId = hubOf(world)
  const { status, bytes } = await downloadFileViaApi(request, hubId, s.file!.fileId, s.volunteerSeed!)
  expect(status).toBe(200)
  expect(bytesToHex(bytes)).toBe(bytesToHex(s.file!.ciphertext))

  const env = await apiGet<FileEnvelopesResponse>(request, `/hubs/${hubId}/files/${s.file!.fileId}/envelopes`, s.volunteerSeed!)
  const me = hpkeRecipientForSeed(s.volunteerSeed!)
  // A member without files:download-all receives exactly their own envelope.
  expect(env.data.envelopes.map(e => e.pubkey)).toEqual([me.pubkeyHex])
  const key = await unwrapKey(env.data.envelopes[0].ct, env.data.envelopes[0].enc, me.skHex, LABEL_FILE_KEY)
  expect(decryptContent(bytesToHex(bytes), key, LABEL_FILE_KEY)).toBe(s.file!.plaintext)
})

Then('the hub admin can read every envelope of the file', async ({ request, world }) => {
  const s = st(world)
  const hubId = hubOf(world)
  const env = await apiGet<FileEnvelopesResponse>(request, `/hubs/${hubId}/files/${s.file!.fileId}/envelopes`, s.hubAdminSeed!)
  expect(env.status).toBe(200)
  expect(env.data.envelopes.map(e => e.pubkey).sort()).toEqual(
    [hpkeRecipientForSeed(s.volunteerSeed!).pubkeyHex, hpkeRecipientForSeed(ADMIN_SEED).pubkeyHex].sort(),
  )
  const content = await downloadFileViaApi(request, hubId, s.file!.fileId, s.hubAdminSeed!)
  expect(content.status).toBe(200)
})

Then('requesting the file through the other hub answers 404', async ({ request, world }) => {
  const s = st(world)
  // The admin is a member of both hubs, so a 404 here is the file's hub
  // boundary, not a membership refusal.
  const env = await apiGet(request, `/hubs/${s.otherHubId!}/files/${s.file!.fileId}/envelopes`)
  expect(env.status).toBe(404)
  const content = await downloadFileViaApi(request, s.otherHubId!, s.file!.fileId)
  expect(content.status).toBe(404)
})

When('the admin starts an upload in the other hub naming that record', async ({ request, world }) => {
  const res = await apiPost(request, `/hubs/${st(world).otherHubId!}/uploads/init`, {
    totalSize: 16, totalChunks: 1, owner: { kind: 'case_record', caseRecordId: cmsRecordId(world) },
  })
  st(world).lastStatus = res.status
})

When('the admin starts an upload on the unscoped route', async ({ request, world }) => {
  const res = await apiPost(request, '/uploads/init', {
    totalSize: 16, totalChunks: 1, owner: { kind: 'entity_field' },
  })
  st(world).lastStatus = res.status
})

Then('the upload is refused with 404', async ({ world }) => {
  expect(st(world).lastStatus).toBe(404)
})

When('the admin registers evidence naming a file that was never uploaded', async ({ request, world }) => {
  const res = await apiPost(request, `/hubs/${hubOf(world)}/records/${cmsRecordId(world)}/evidence`, {
    fileId: crypto.randomUUID(),
    filename: 'absent.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 16,
    classification: 'photo',
    integrityHash: 'a'.repeat(64),
    source: 'volunteer_upload',
  })
  st(world).lastStatus = res.status
})

Then('the evidence registration is refused with 404', async ({ world }) => {
  expect(st(world).lastStatus).toBe(404)
})
