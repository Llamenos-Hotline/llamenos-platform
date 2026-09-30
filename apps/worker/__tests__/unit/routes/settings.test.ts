import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import settingsRoute from '@worker/routes/settings'
import { encodePcm16Wav } from '@/lib/ivr-wav'

function createTestApp(opts: {
  permissions?: string[]
  pubkey?: string
  services?: Record<string, unknown>
  /** Set when the request is routed under /hubs/:hubId (hubContext sets it). */
  hubId?: string
  /** Permissions granted only at hub scope (set by hubContext for hub members). */
  hubPermissions?: string[]
} = {}) {
  const {
    hubId,
    hubPermissions,
    permissions = ['*'],
    pubkey = 'test-pubkey-' + '0'.repeat(50),
    services = {},
  } = opts

  const mockAuditService = { log: vi.fn().mockResolvedValue(undefined) }

  const defaultServices = {
    settings: {
      getTranscriptionSettings: vi.fn().mockResolvedValue({ enabled: true, model: 'whisper' }),
      updateTranscriptionSettings: vi.fn().mockResolvedValue({ enabled: true, model: 'whisper' }),
      getCustomFields: vi.fn().mockResolvedValue([{ id: 'cf-1', name: 'Field 1' }]),
      updateCustomFields: vi.fn().mockResolvedValue([{ id: 'cf-1', name: 'Field 1' }]),
      getSpamSettings: vi.fn().mockResolvedValue({ voiceCaptchaEnabled: false }),
      updateSpamSettings: vi.fn().mockResolvedValue({ voiceCaptchaEnabled: false }),
      getCallSettings: vi.fn().mockResolvedValue({ queueTimeoutSeconds: 90 }),
      updateCallSettings: vi.fn().mockResolvedValue({ queueTimeoutSeconds: 90 }),
      getIvrLanguages: vi.fn().mockResolvedValue({ languages: ['en'] }),
      updateIvrLanguages: vi.fn().mockResolvedValue({ languages: ['en'] }),
      getTelephonyProvider: vi.fn().mockResolvedValue({ type: 'twilio', phoneNumber: '+1555000000' }),
      updateTelephonyProvider: vi.fn().mockResolvedValue({ type: 'twilio', phoneNumber: '+1555000000' }),
      getMessagingConfig: vi.fn().mockResolvedValue({ channels: ['sms'] }),
      updateMessagingConfig: vi.fn().mockResolvedValue({ channels: ['sms'] }),
      getSetupState: vi.fn().mockResolvedValue({ setupCompleted: true }),
      updateSetupState: vi.fn().mockResolvedValue({ setupCompleted: true }),
      getIvrAudioList: vi.fn().mockResolvedValue({ prompts: [] }),
      uploadIvrAudio: vi.fn().mockResolvedValue({ ok: true }),
      deleteIvrAudio: vi.fn().mockResolvedValue({ ok: true }),
      getReportTypes: vi.fn().mockResolvedValue([{ id: 'rt-1', name: 'Type 1' }]),
      createReportType: vi.fn().mockResolvedValue({ id: 'rt-1', name: 'Type 1' }),
      updateReportType: vi.fn().mockResolvedValue({ id: 'rt-1', name: 'Updated' }),
      archiveReportType: vi.fn().mockResolvedValue({ ok: true }),
      getRoles: vi.fn().mockResolvedValue([{ id: 'role-1', name: 'Admin' }]),
      createRole: vi.fn().mockResolvedValue({ id: 'role-1', name: 'Admin' }),
      updateRole: vi.fn().mockResolvedValue({ id: 'role-1', name: 'Admin' }),
      deleteRole: vi.fn().mockResolvedValue({ ok: true }),
      getTTLOverrides: vi.fn().mockResolvedValue({}),
      updateTTLOverrides: vi.fn().mockResolvedValue({}),
      getCleanupMetrics: vi.fn().mockResolvedValue({}),
      getGeocodingConfig: vi.fn().mockResolvedValue({ provider: 'google', countries: ['US'], enabled: true }),
      updateGeocodingConfig: vi.fn().mockResolvedValue({ provider: 'google', countries: ['US'], enabled: true }),
      getGeocodingConfigAdmin: vi.fn().mockResolvedValue({ provider: 'google', apiKey: 'secret', countries: ['US'], enabled: true }),
    },
    identity: {
      getWebAuthnSettings: vi.fn().mockResolvedValue({ enabled: true }),
      updateWebAuthnSettings: vi.fn().mockResolvedValue({ enabled: true }),
    },
    audit: mockAuditService,
  }

  const mergedServices: Record<string, unknown> = { ...defaultServices, ...services }
  for (const key of Object.keys(services)) {
    const svcVal = (services as Record<string, unknown>)[key]
    const defVal = (defaultServices as Record<string, unknown>)[key]
    if (typeof svcVal === 'object' && svcVal !== null && typeof defVal === 'object' && defVal !== null) {
      mergedServices[key] = { ...(defVal as Record<string, unknown>), ...(svcVal as Record<string, unknown>) }
    }
  }

  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('services', mergedServices as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', [])
    c.set('requestId', 'test-req-1')
    if (hubId) c.set('hubId', hubId)
    if (hubPermissions) c.set('hubPermissions', hubPermissions)
    Object.defineProperty(c, 'executionCtx', {
      value: { waitUntil: vi.fn() },
      writable: true,
      configurable: true,
    })
    await next()
  })

  app.route('/', settingsRoute)
  return app
}

describe('settings route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('transcription', () => {
    it('GET /transcription returns settings with manage-transcription permission', async () => {
      const app = createTestApp({ permissions: ['settings:manage-transcription'] })
      const res = await app.request('/transcription')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.enabled).toBe(true)
    })

    it('GET /transcription requires manage-transcription permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/transcription')
      expect(res.status).toBe(403)
    })

    it('PATCH /transcription requires manage-transcription permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/transcription', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
      expect(res.status).toBe(403)
    })

    it('PATCH /transcription updates settings with permission', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ globalEnabled: false, allowUserOptOut: true })
      const app = createTestApp({
        permissions: ['settings:manage-transcription'],
        services: { settings: { updateTranscriptionSettings: updateSpy } },
      })
      const res = await app.request('/transcription', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ globalEnabled: false }),
      })
      expect(res.status).toBe(200)
      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ globalEnabled: false }))
    })
  })

  describe('custom-fields', () => {
    it('GET /custom-fields returns fields filtered by role', async () => {
      const getSpy = vi.fn().mockResolvedValue([{ id: 'cf-1' }])
      const app = createTestApp({
        permissions: ['settings:manage-fields', 'settings:read'],
        services: { settings: { getCustomFields: getSpy } },
      })
      const res = await app.request('/custom-fields')
      expect(res.status).toBe(200)
      expect(getSpy).toHaveBeenCalledWith('admin')
    })

    it('GET /custom-fields passes volunteer filter without manage-fields', async () => {
      const getSpy = vi.fn().mockResolvedValue([{ id: 'cf-1' }])
      const app = createTestApp({
        permissions: ['settings:read'],
        services: { settings: { getCustomFields: getSpy } },
      })
      await app.request('/custom-fields')
      expect(getSpy).toHaveBeenCalledWith('volunteer')
    })

    it('PUT /custom-fields requires manage-fields permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/custom-fields', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ id: 'cf-1', name: 'Test' }]),
      })
      expect(res.status).toBe(403)
    })
  })

  describe('spam settings', () => {
    it('GET /spam requires manage-spam permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/spam')
      expect(res.status).toBe(403)
    })

    it('PATCH /spam updates settings with permission', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ voiceCaptchaEnabled: true })
      const app = createTestApp({
        permissions: ['settings:manage-spam'],
        services: { settings: { updateSpamSettings: updateSpy } },
      })
      const res = await app.request('/spam', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceCaptchaEnabled: true }),
      })
      expect(res.status).toBe(200)
      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ voiceCaptchaEnabled: true }), undefined)
    })

    it('PATCH /spam under a hub writes that hub only, never the platform values (#1051)', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ voiceCaptchaEnabled: true })
      const app = createTestApp({
        permissions: [],
        hubPermissions: ['settings:manage-spam'],
        hubId: 'hub-a',
        services: { settings: { updateSpamSettings: updateSpy } },
      })
      const res = await app.request('/spam?hubId=hub-b', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceCaptchaEnabled: true }),
      })
      expect(res.status).toBe(200)
      // hub context wins over a ?hubId= query aimed at another hub
      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ voiceCaptchaEnabled: true }), 'hub-a')
    })

    it('GET /spam under a hub reads that hub', async () => {
      const getSpy = vi.fn().mockResolvedValue({ voiceCaptchaEnabled: false })
      const app = createTestApp({
        permissions: ['settings:manage-spam'],
        hubId: 'hub-a',
        services: { settings: { getSpamSettings: getSpy } },
      })
      const res = await app.request('/spam')
      expect(res.status).toBe(200)
      expect(getSpy).toHaveBeenCalledWith('hub-a')
    })
  })

  describe('call settings', () => {
    it('GET /call requires manage-calls permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/call')
      expect(res.status).toBe(403)
    })

    it('PATCH /call updates settings with permission', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ queueTimeoutSeconds: 120 })
      const app = createTestApp({
        permissions: ['settings:manage-calls'],
        services: { settings: { updateCallSettings: updateSpy } },
      })
      const res = await app.request('/call', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueTimeoutSeconds: 120 }),
      })
      expect(res.status).toBe(200)
      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ queueTimeoutSeconds: 120 }), undefined)
    })

    it('PATCH /call under a hub writes that hub only (#1051)', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ queueTimeoutSeconds: 120 })
      const app = createTestApp({
        permissions: ['settings:manage-calls'],
        hubId: 'hub-a',
        services: { settings: { updateCallSettings: updateSpy } },
      })
      const res = await app.request('/call?hubId=hub-b', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueTimeoutSeconds: 120 }),
      })
      expect(res.status).toBe(200)
      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ queueTimeoutSeconds: 120 }), 'hub-a')
    })
  })

  describe('ivr-languages', () => {
    it('GET /ivr-languages requires manage-ivr permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/ivr-languages')
      expect(res.status).toBe(403)
    })

    it('PATCH /ivr-languages updates with permission', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ enabledLanguages: ['en', 'es'] })
      const app = createTestApp({
        permissions: ['settings:manage-ivr'],
        services: { settings: { updateIvrLanguages: updateSpy } },
      })
      const res = await app.request('/ivr-languages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledLanguages: ['en', 'es'] }),
      })
      expect(res.status).toBe(200)
    })
  })

  describe('webauthn', () => {
    it('GET /webauthn requires manage-webauthn permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/webauthn')
      expect(res.status).toBe(403)
    })

    it('PATCH /webauthn updates with permission', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ requireForAdmins: false, requireForUsers: false })
      const app = createTestApp({
        permissions: ['settings:manage-webauthn'],
        services: { identity: { updateWebAuthnSettings: updateSpy } },
      })
      const res = await app.request('/webauthn', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireForAdmins: false }),
      })
      expect(res.status).toBe(200)
      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ requireForAdmins: false }))
    })

    // #672: enabling requireForAdmins without a credential locks the caller out
    it('PATCH /webauthn rejects requireForAdmins=true when the caller has no passkey', async () => {
      const updateSpy = vi.fn()
      const credsSpy = vi.fn().mockResolvedValue({ credentials: [] })
      const pubkey = 'a'.repeat(64)
      const app = createTestApp({
        pubkey,
        permissions: ['settings:manage-webauthn'],
        services: { identity: { updateWebAuthnSettings: updateSpy, getWebAuthnCredentials: credsSpy } },
      })
      const res = await app.request('/webauthn', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireForAdmins: true }),
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: 'WEBAUTHN_CREDENTIAL_REQUIRED' })
      expect(credsSpy).toHaveBeenCalledWith(pubkey)
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('PATCH /webauthn persists requireForAdmins=true when the caller has a passkey', async () => {
      const persisted = { requireForAdmins: true, requireForUsers: false }
      const updateSpy = vi.fn().mockResolvedValue(persisted)
      const credsSpy = vi.fn().mockResolvedValue({ credentials: [{ id: 'cred-1' }] })
      const app = createTestApp({
        permissions: ['settings:manage-webauthn'],
        services: { identity: { updateWebAuthnSettings: updateSpy, getWebAuthnCredentials: credsSpy } },
      })
      const res = await app.request('/webauthn', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireForAdmins: true }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(persisted)
      expect(updateSpy).toHaveBeenCalledWith({ requireForAdmins: true })
    })

    it('PATCH /webauthn does not require a passkey to change only requireForUsers', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ requireForAdmins: false, requireForUsers: true })
      const credsSpy = vi.fn().mockResolvedValue({ credentials: [] })
      const app = createTestApp({
        permissions: ['settings:manage-webauthn'],
        services: { identity: { updateWebAuthnSettings: updateSpy, getWebAuthnCredentials: credsSpy } },
      })
      const res = await app.request('/webauthn', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireForUsers: true }),
      })
      expect(res.status).toBe(200)
      expect(credsSpy).not.toHaveBeenCalled()
    })
  })

  describe('telephony-provider', () => {
    it('GET /telephony-provider requires manage-telephony permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/telephony-provider')
      expect(res.status).toBe(403)
    })

    it('PATCH /telephony-provider updates with permission', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ type: 'twilio' })
      const app = createTestApp({
        permissions: ['settings:manage-telephony'],
        services: { settings: { updateTelephonyProvider: updateSpy } },
      })
      const res = await app.request('/telephony-provider', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'twilio', accountSid: 'AC' + 'a'.repeat(32), authToken: 'token' }),
      })
      expect(res.status).toBe(200)
    })

    it('POST /telephony-provider/test requires manage-telephony permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/telephony-provider/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'twilio', accountSid: 'AC123', authToken: 'token' }),
      })
      expect(res.status).toBe(403)
    })
  })

  describe('messaging', () => {
    it('GET /messaging requires manage-messaging permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/messaging')
      expect(res.status).toBe(403)
    })

    it('PATCH /messaging updates with permission', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ enabledChannels: ['sms', 'whatsapp'] })
      const app = createTestApp({
        permissions: ['settings:manage-messaging'],
        services: { settings: { updateMessagingConfig: updateSpy } },
      })
      const res = await app.request('/messaging', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledChannels: ['sms', 'whatsapp'] }),
      })
      expect(res.status).toBe(200)
      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ enabledChannels: ['sms', 'whatsapp'] }))
    })
  })

  describe('setup', () => {
    it('GET /setup requires manage-setup permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/setup')
      expect(res.status).toBe(403)
    })

    it('PATCH /setup updates with permission', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ setupCompleted: true })
      const app = createTestApp({
        permissions: ['settings:manage-setup'],
        services: { settings: { updateSetupState: updateSpy } },
      })
      const res = await app.request('/setup', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupCompleted: true }),
      })
      expect(res.status).toBe(200)
    })
  })

  describe('ivr-audio', () => {
    it('GET /ivr-audio requires manage-ivr permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/ivr-audio')
      expect(res.status).toBe(403)
    })

    it('PUT /ivr-audio/:promptType/:language uploads audio with permission', async () => {
      const uploadSpy = vi.fn().mockResolvedValue({ ok: true })
      const app = createTestApp({
        permissions: ['settings:manage-ivr'],
        services: { settings: { uploadIvrAudio: uploadSpy } },
      })
      // 10 ms of 8 kHz mono PCM: the only format the route accepts (see
      // deploy/docker/tests/telephony/ivr-audio.test.ts for the rejections)
      const audioData = encodePcm16Wav(new Float32Array(80), 8000)
      const res = await app.request('/ivr-audio/greeting/en', {
        method: 'PUT',
        body: audioData,
      })
      expect(res.status).toBe(200)
      expect(uploadSpy).toHaveBeenCalledWith('greeting', 'en', Buffer.from(audioData).toString('base64'), audioData.byteLength)
    })

    it('DELETE /ivr-audio/:promptType/:language removes audio with permission', async () => {
      const deleteSpy = vi.fn().mockResolvedValue({ ok: true })
      const app = createTestApp({
        permissions: ['settings:manage-ivr'],
        services: { settings: { deleteIvrAudio: deleteSpy } },
      })
      const res = await app.request('/ivr-audio/greeting/en', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(deleteSpy).toHaveBeenCalledWith('greeting', 'en')
    })
  })

  describe('report-types', () => {
    it('GET /report-types requires settings:read', async () => {
      const app = createTestApp({ permissions: [] })
      const res = await app.request('/report-types')
      expect(res.status).toBe(403)
    })

    it('POST /report-types requires manage-fields permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/report-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Type' }),
      })
      expect(res.status).toBe(403)
    })

    it('POST /report-types creates with permission', async () => {
      const createSpy = vi.fn().mockResolvedValue({ id: 'rt-new', name: 'New Type' })
      const app = createTestApp({
        permissions: ['settings:manage-fields'],
        services: { settings: { createReportType: createSpy } },
      })
      const res = await app.request('/report-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Type' }),
      })
      expect(res.status).toBe(201)
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Type' }))
    })

    it('PATCH /report-types/:id updates with permission', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ id: 'rt-1', name: 'Updated' })
      const app = createTestApp({
        permissions: ['settings:manage-fields'],
        services: { settings: { updateReportType: updateSpy } },
      })
      const res = await app.request('/report-types/rt-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      })
      expect(res.status).toBe(200)
      expect(updateSpy).toHaveBeenCalledWith('rt-1', expect.any(Object))
    })

    it('DELETE /report-types/:id archives with permission', async () => {
      const archiveSpy = vi.fn().mockResolvedValue({ ok: true })
      const app = createTestApp({
        permissions: ['settings:manage-fields'],
        services: { settings: { archiveReportType: archiveSpy } },
      })
      const res = await app.request('/report-types/rt-1', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(archiveSpy).toHaveBeenCalledWith('rt-1')
    })
  })

  describe('roles', () => {
    it('GET /roles requires system:view-roles', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/roles')
      expect(res.status).toBe(403)
    })

    it('POST /roles requires system:manage-roles', async () => {
      const app = createTestApp({ permissions: ['system:view-roles'] })
      const res = await app.request('/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Role' }),
      })
      expect(res.status).toBe(403)
    })

    it('POST /roles creates with permission', async () => {
      const createSpy = vi.fn().mockResolvedValue({ id: 'role-new', name: 'New Role' })
      const app = createTestApp({
        permissions: ['system:manage-roles'],
        services: { settings: { createRole: createSpy } },
      })
      const res = await app.request('/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Role', slug: 'new-role', permissions: ['settings:read'], description: 'A new role' }),
      })
      expect(res.status).toBe(201)
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Role' }))
    })

    it('PATCH /roles/:id updates with permission', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ id: 'role-1', name: 'Updated' })
      const app = createTestApp({
        permissions: ['system:manage-roles'],
        services: { settings: { updateRole: updateSpy } },
      })
      const res = await app.request('/roles/role-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      })
      expect(res.status).toBe(200)
      expect(updateSpy).toHaveBeenCalledWith('role-1', expect.any(Object))
    })

    it('DELETE /roles/:id removes with permission', async () => {
      const deleteSpy = vi.fn().mockResolvedValue({ ok: true })
      const app = createTestApp({
        permissions: ['system:manage-roles'],
        services: { settings: { deleteRole: deleteSpy } },
      })
      const res = await app.request('/roles/role-1', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(deleteSpy).toHaveBeenCalledWith('role-1')
    })
  })

  describe('permissions catalog', () => {
    it('GET /permissions requires system:manage-roles', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/permissions')
      expect(res.status).toBe(403)
    })

    it('GET /permissions returns catalog with permission', async () => {
      const app = createTestApp({ permissions: ['system:manage-roles'] })
      const res = await app.request('/permissions')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.permissions).toBeDefined()
      expect(body.byDomain).toBeDefined()
    })
  })

  describe('migrations', () => {
    it('GET /migrations requires system:manage-roles', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/migrations')
      expect(res.status).toBe(403)
    })

    it('GET /migrations returns service-based note', async () => {
      const app = createTestApp({ permissions: ['system:manage-roles'] })
      const res = await app.request('/migrations')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.namespaces).toEqual([])
      expect(body.note).toContain('Service-based deployment')
    })
  })

  describe('ttl overrides', () => {
    it('GET /ttl requires manage-ttl permission', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/ttl')
      expect(res.status).toBe(403)
    })

    it('PATCH /ttl updates with permission', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ conversationTTL: 86400 })
      const app = createTestApp({
        permissions: ['settings:manage-ttl'],
        services: { settings: { updateTTLOverrides: updateSpy } },
      })
      const res = await app.request('/ttl', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationTTL: 86400 }),
      })
      expect(res.status).toBe(200)
      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ conversationTTL: 86400 }))
    })
  })

  describe('cleanup-metrics', () => {
    it('GET /cleanup-metrics requires settings:manage', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/cleanup-metrics')
      expect(res.status).toBe(403)
    })

    it('GET /cleanup-metrics returns aggregated metrics', async () => {
      const app = createTestApp({
        permissions: ['settings:manage'],
        services: { settings: { getCleanupMetrics: vi.fn().mockResolvedValue({ deleted: 5 }) } },
      })
      const res = await app.request('/cleanup-metrics')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.settings).toEqual({ deleted: 5 })
    })
  })

  describe('geocoding', () => {
    it('GET /geocoding calls safe method (no apiKey) for users with settings:read', async () => {
      const getGeocodingConfig = vi.fn().mockResolvedValue({ provider: 'opencage', countries: ['US'], enabled: true })
      const getGeocodingConfigAdmin = vi.fn().mockResolvedValue({ provider: 'opencage', apiKey: 'secret', countries: ['US'], enabled: true })
      const app = createTestApp({
        permissions: ['settings:read'],
        services: { settings: { getGeocodingConfig, getGeocodingConfigAdmin } },
      })
      const res = await app.request('/geocoding')
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.provider).toBe('opencage')
      // Safe method called — not admin method
      expect(getGeocodingConfig).toHaveBeenCalled()
      expect(getGeocodingConfigAdmin).not.toHaveBeenCalled()
      // API key must not be exposed to regular users
      expect(body.apiKey).toBeUndefined()
    })

    it('GET /geocoding/admin calls admin method (with apiKey) for privileged user', async () => {
      const getGeocodingConfigAdmin = vi.fn().mockResolvedValue({ provider: 'opencage', apiKey: 'secret', countries: ['US'], enabled: true })
      const app = createTestApp({
        permissions: ['settings:manage'],
        services: { settings: { getGeocodingConfigAdmin } },
      })
      await app.request('/geocoding/test')
      // /geocoding/test uses getGeocodingConfigAdmin to look up the API key
      expect(getGeocodingConfigAdmin).toHaveBeenCalled()
    })

    it('PUT /geocoding requires settings:manage', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/geocoding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google', countries: ['US'], enabled: true }),
      })
      expect(res.status).toBe(403)
    })

    it('GET /geocoding/test requires settings:manage', async () => {
      const app = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/geocoding/test')
      expect(res.status).toBe(403)
    })
  })
})
