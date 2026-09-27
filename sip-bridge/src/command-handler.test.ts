import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CommandHandler } from './command-handler'
import type { BridgeClient } from './bridge-client'
import type { WebhookSender } from './webhook-sender'
import type { BridgeConfig, BridgeCommand } from './types'

// ---- Mock BridgeClient ----

function createMockClient(): BridgeClient & {
  calls: Array<{ method: string; args: unknown[] }>
} {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const track = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args })
    return Promise.resolve()
  }

  return {
    calls,
    connect: track('connect') as BridgeClient['connect'],
    disconnect: () => calls.push({ method: 'disconnect', args: [] }),
    isConnected: () => true,
    onEvent: () => {},
    offEvent: () => {},
    originate: (async (params: unknown) => {
      calls.push({ method: 'originate', args: [params] })
      return { id: `ch-${Date.now()}` }
    }) as BridgeClient['originate'],
    hangup: track('hangup') as BridgeClient['hangup'],
    answer: track('answer') as BridgeClient['answer'],
    bridge: (async (...args: unknown[]) => {
      calls.push({ method: 'bridge', args })
      return `bridge-${Date.now()}`
    }) as BridgeClient['bridge'],
    destroyBridge: track('destroyBridge') as BridgeClient['destroyBridge'],
    playMedia: (async (...args: unknown[]) => {
      calls.push({ method: 'playMedia', args })
      return `pb-${Date.now()}`
    }) as BridgeClient['playMedia'],
    stopPlayback: track('stopPlayback') as BridgeClient['stopPlayback'],
    startMoh: track('startMoh') as BridgeClient['startMoh'],
    stopMoh: track('stopMoh') as BridgeClient['stopMoh'],
    recordChannel: track('recordChannel') as BridgeClient['recordChannel'],
    recordBridge: track('recordBridge') as BridgeClient['recordBridge'],
    stopRecording: track('stopRecording') as BridgeClient['stopRecording'],
    getRecordingFile: (async () => null) as BridgeClient['getRecordingFile'],
    deleteRecording: track('deleteRecording') as BridgeClient['deleteRecording'],
    setChannelVar: track('setChannelVar') as BridgeClient['setChannelVar'],
    getChannelVar: (async () => '') as BridgeClient['getChannelVar'],
    healthCheck: (async () => ({
      ok: true,
      latencyMs: 5,
    })) as BridgeClient['healthCheck'],
    listChannels: (async () => []) as BridgeClient['listChannels'],
    listBridges: (async () => []) as BridgeClient['listBridges'],
  }
}

// ---- Mock WebhookSender ----

function createMockWebhook(
  responseCommands?: BridgeCommand[] | null
): WebhookSender & { sentWebhooks: Array<{ path: string; payload: unknown }> } {
  const sentWebhooks: Array<{ path: string; payload: unknown }> = []
  return {
    sentWebhooks,
    sendWebhookForCommands: async (path: string, payload: unknown) => {
      sentWebhooks.push({ path, payload })
      return responseCommands ?? null
    },
    sendWebhook: async () => new Response('OK', { status: 200 }),
    verifySignature: () => true,
  } as unknown as WebhookSender & { sentWebhooks: Array<{ path: string; payload: unknown }> }
}

const baseConfig: BridgeConfig = {
  pbxType: 'asterisk',
  ariUrl: '',
  ariRestUrl: '',
  ariUsername: '',
  ariPassword: '',
  eslHost: '',
  eslPort: 8021,
  eslPassword: '',
  kamailioJsonrpcUrl: '',
  workerWebhookUrl: 'http://worker:3000',
  bridgeSecret: 'test-secret',
  bridgePort: 3000,
  bridgeHost: '0.0.0.0',
  stasisApp: 'llamenos',
  connectionTimeoutMs: 300000,
}

describe('CommandHandler', () => {
  let client: ReturnType<typeof createMockClient>
  let webhook: ReturnType<typeof createMockWebhook>
  let handler: CommandHandler

  beforeEach(() => {
    client = createMockClient()
    webhook = createMockWebhook()
    handler = new CommandHandler(client, webhook, baseConfig)
    handler.setHotlineNumber('+15551234567')
  })

  // ================================================================
  // Gather digit buffering
  // ================================================================

  describe('gather digit buffering', () => {
    it('collects DTMF digits up to numDigits and sends result', async () => {
      // Create an incoming call
      await handler.handleEvent({
        type: 'channel_create',
        channelId: 'ch-1',
        callerNumber: '+15559876543',
        calledNumber: '+15551234567',
        args: [],
        timestamp: new Date().toISOString(),
      })

      // Execute a gather command
      await handler.executeCommands([
        {
          action: 'gather',
          channelId: 'ch-1',
          numDigits: 3,
          timeout: 10,
          callbackPath: '/api/telephony/language',
          callbackParams: { hubId: 'hub-1' },
        },
      ])

      // Send DTMF digits one at a time
      await handler.handleEvent({
        type: 'dtmf_received',
        channelId: 'ch-1',
        digit: '1',
        durationMs: 100,
        timestamp: new Date().toISOString(),
      })

      // Not enough digits yet — no webhook sent beyond the initial incoming
      expect(webhook.sentWebhooks.length).toBe(1) // only the incoming webhook

      await handler.handleEvent({
        type: 'dtmf_received',
        channelId: 'ch-1',
        digit: '2',
        durationMs: 100,
        timestamp: new Date().toISOString(),
      })

      expect(webhook.sentWebhooks.length).toBe(1) // still waiting

      await handler.handleEvent({
        type: 'dtmf_received',
        channelId: 'ch-1',
        digit: '3',
        durationMs: 100,
        timestamp: new Date().toISOString(),
      })

      // Now we should have the gather result webhook
      expect(webhook.sentWebhooks.length).toBe(2)
      const gatherWebhook = webhook.sentWebhooks[1]
      expect(gatherWebhook.path).toBe('/api/telephony/language')
      expect((gatherWebhook.payload as { digits: string }).digits).toBe('123')
    })

    it('does not send gather result for digits without active gather', async () => {
      // Create call
      await handler.handleEvent({
        type: 'channel_create',
        channelId: 'ch-2',
        callerNumber: '+15559876543',
        calledNumber: '+15551234567',
        args: [],
        timestamp: new Date().toISOString(),
      })

      // Send DTMF without a gather — should be ignored
      await handler.handleEvent({
        type: 'dtmf_received',
        channelId: 'ch-2',
        digit: '5',
        durationMs: 100,
        timestamp: new Date().toISOString(),
      })

      // Only the incoming webhook, no gather result
      expect(webhook.sentWebhooks.length).toBe(1)
    })
  })

  // ================================================================
  // Tier 5 recording guard in execBridge
  // ================================================================

  describe('Tier 5 SFrame recording guard', () => {
    it('blocks recording for sframe mode calls', async () => {
      // Create an SFrame call (enters via sframe dialplan context)
      await handler.handleEvent({
        type: 'channel_create',
        channelId: 'ch-sframe',
        callerNumber: '+15559876543',
        calledNumber: '+15551234567',
        args: ['sframe'],
        timestamp: new Date().toISOString(),
      })

      // Create a volunteer channel
      await handler.handleEvent({
        type: 'channel_create',
        channelId: 'ch-vol',
        callerNumber: '+15559876543',
        calledNumber: '+15551234567',
        args: ['dialed', 'ch-sframe', 'pubkey123'],
        timestamp: new Date().toISOString(),
      })

      // Try to bridge with recording enabled
      await handler.executeCommands([
        {
          action: 'bridge',
          callerChannelId: 'ch-sframe',
          volunteerChannelId: 'ch-vol',
          record: true,
          recordingCallbackPath: '/api/telephony/recording',
        },
      ])

      // Bridge should be created
      const bridgeCalls = client.calls.filter((c) => c.method === 'bridge')
      expect(bridgeCalls.length).toBe(1)

      // But recording should NOT be started (SFrame guard blocks it)
      const recordCalls = client.calls.filter((c) => c.method === 'recordBridge')
      expect(recordCalls.length).toBe(0)
    })

    it('allows recording for pstn mode calls', async () => {
      // Create a PSTN call (no sframe arg)
      await handler.handleEvent({
        type: 'channel_create',
        channelId: 'ch-pstn',
        callerNumber: '+15559876543',
        calledNumber: '+15551234567',
        args: [],
        timestamp: new Date().toISOString(),
      })

      // Create a volunteer channel (originated by us)
      await handler.handleEvent({
        type: 'channel_create',
        channelId: 'ch-vol2',
        callerNumber: '+15559876543',
        calledNumber: '+15551234567',
        args: ['dialed', 'ch-pstn', 'pubkey456'],
        timestamp: new Date().toISOString(),
      })

      // Bridge with recording
      await handler.executeCommands([
        {
          action: 'bridge',
          callerChannelId: 'ch-pstn',
          volunteerChannelId: 'ch-vol2',
          record: true,
          recordingCallbackPath: '/api/telephony/recording',
        },
      ])

      // Both bridge and recording should happen
      const bridgeCalls = client.calls.filter((c) => c.method === 'bridge')
      expect(bridgeCalls.length).toBe(1)

      const recordCalls = client.calls.filter((c) => c.method === 'recordBridge')
      expect(recordCalls.length).toBe(1)
    })
  })

  // ================================================================
  // Cleanup on hangup
  // ================================================================

  describe('cleanup on hangup', () => {
    it('removes call state and sends status webhook on hangup', async () => {
      // Create a call
      await handler.handleEvent({
        type: 'channel_create',
        channelId: 'ch-cleanup',
        callerNumber: '+15559876543',
        calledNumber: '+15551234567',
        args: [],
        timestamp: new Date().toISOString(),
      })

      // Verify call is tracked
      const statusBefore = handler.getStatus()
      expect(statusBefore.activeCalls).toBe(1)

      // Hang up
      await handler.handleEvent({
        type: 'channel_hangup',
        channelId: 'ch-cleanup',
        cause: 16, // NORMAL_CLEARING
        causeText: 'Normal Clearing',
        timestamp: new Date().toISOString(),
      })

      // Call should be cleaned up
      const statusAfter = handler.getStatus()
      expect(statusAfter.activeCalls).toBe(0)
    })

    it('clears gather timeout on hangup', async () => {
      // Create a call
      await handler.handleEvent({
        type: 'channel_create',
        channelId: 'ch-gather-cleanup',
        callerNumber: '+15559876543',
        calledNumber: '+15551234567',
        args: [],
        timestamp: new Date().toISOString(),
      })

      // Start a gather
      await handler.executeCommands([
        {
          action: 'gather',
          channelId: 'ch-gather-cleanup',
          numDigits: 1,
          timeout: 30,
          callbackPath: '/api/telephony/language',
        },
      ])

      // Hang up while gather is active — should not throw
      await handler.handleEvent({
        type: 'channel_hangup',
        channelId: 'ch-gather-cleanup',
        cause: 16,
        causeText: 'Normal Clearing',
        timestamp: new Date().toISOString(),
      })

      expect(handler.getStatus().activeCalls).toBe(0)
    })

    it('clears queue state on hangup and sends queue-exit webhook', async () => {
      // Use a webhook mock that returns a queue command
      const queueWebhook = createMockWebhook([
        {
          action: 'queue',
          channelId: 'ch-queue',
          musicOnHold: 'default',
          exitCallbackPath: '/api/telephony/queue-exit',
        },
      ])
      const queueHandler = new CommandHandler(client, queueWebhook, baseConfig)
      queueHandler.setHotlineNumber('+15551234567')

      // Create a call — the incoming webhook response will queue it
      await queueHandler.handleEvent({
        type: 'channel_create',
        channelId: 'ch-queue',
        callerNumber: '+15559876543',
        calledNumber: '+15551234567',
        args: [],
        timestamp: new Date().toISOString(),
      })

      expect(queueHandler.getStatus().activeQueues).toBe(1)

      // Hang up — should send queue-exit webhook with 'hangup' result
      await queueHandler.handleEvent({
        type: 'channel_hangup',
        channelId: 'ch-queue',
        cause: 16,
        causeText: 'Normal Clearing',
        timestamp: new Date().toISOString(),
      })

      expect(queueHandler.getStatus().activeCalls).toBe(0)
      expect(queueHandler.getStatus().activeQueues).toBe(0)

      // Check that queue-exit webhook was sent
      const exitWebhook = queueWebhook.sentWebhooks.find(
        (w) => w.path === '/api/telephony/queue-exit'
      )
      expect(exitWebhook).toBeTruthy()
      expect((exitWebhook!.payload as { queueResult: string }).queueResult).toBe('hangup')

      queueHandler.dispose()
    })

    it('cancels ringing channels when caller hangs up', async () => {
      // Create a caller
      await handler.handleEvent({
        type: 'channel_create',
        channelId: 'ch-caller',
        callerNumber: '+15559876543',
        calledNumber: '+15551234567',
        args: [],
        timestamp: new Date().toISOString(),
      })

      // Simulate ringing volunteers by executing a ring command
      await handler.executeCommands([
        {
          action: 'ring',
          endpoint: 'PJSIP/100@trunk',
          callerId: '+15559876543',
          timeout: 30,
          answerCallbackPath: '/api/telephony/volunteer-answer',
          answerCallbackParams: { parentCallSid: 'ch-caller', pubkey: 'pk1' },
          statusCallbackPath: '/api/telephony/call-status',
        },
      ])

      // Caller hangs up — should trigger cleanup of ringing channels
      await handler.handleEvent({
        type: 'channel_hangup',
        channelId: 'ch-caller',
        cause: 16,
        causeText: 'Normal Clearing',
        timestamp: new Date().toISOString(),
      })

      expect(handler.getStatus().activeCalls).toBe(0)
      expect(handler.getStatus().ringingChannels).toBe(0)
    })
  })

  // ================================================================
  // TTS playback
  // ================================================================

  describe('TTS playback', () => {
    it('plays synthesized audio when TTS engine is configured', async () => {
      const ttsConfig = {
        engine: 'espeak' as const,
        cacheDir: '/tmp/tts-test-cache',
      }
      const ttsHandler = new CommandHandler(client, webhook, { ...baseConfig, ttsConfig })

      await ttsHandler.executeCommands([
        {
          action: 'playback',
          channelId: 'ch-tts',
          media: '',
          text: 'Hello world',
          language: 'en',
        },
      ])

      // Should attempt playback (either TTS file or beep fallback)
      const playCalls = client.calls.filter((c) => c.method === 'playMedia')
      expect(playCalls.length).toBeGreaterThanOrEqual(1)
      ttsHandler.dispose()
    })

    it('falls back to beep when TTS is not configured', async () => {
      await handler.executeCommands([
        {
          action: 'playback',
          channelId: 'ch-no-tts',
          media: '',
          text: 'Hello world',
          language: 'en',
        },
      ])

      const playCalls = client.calls.filter((c) => c.method === 'playMedia' && c.args[1] === 'sound:beep')
      expect(playCalls.length).toBe(1)
    })
  })


  // ================================================================
  // Helpers for the state-loss / restart regressions below (#1154)
  // ================================================================

  const createCall = (channelId: string, args: string[] = []) =>
    handler.handleEvent({
      type: 'channel_create',
      channelId,
      callerNumber: '+15559876543',
      calledNumber: '+15551234567',
      args,
      timestamp: new Date().toISOString(),
    })

  const hangup = (channelId: string, cause = 16) =>
    handler.handleEvent({
      type: 'channel_hangup',
      channelId,
      cause,
      causeText: 'x',
      timestamp: new Date().toISOString(),
    })

  describe('recording guard on the channel path fails closed', () => {
    it('does not record a channel the bridge holds no state for (e.g. after a restart)', async () => {
      // Tier 5 SFrame call whose ActiveCall entry was lost with the process.
      await handler.executeCommands([
        {
          action: 'record',
          channelId: 'ch-unknown',
          name: 'vm-1',
          maxDuration: 60,
          beep: true,
          callbackPath: '/api/telephony/voicemail',
        },
      ])

      expect(client.calls.filter((c) => c.method === 'recordChannel')).toHaveLength(0)
      expect(client.calls.filter((c) => c.method === 'playMedia')).toHaveLength(0)
    })

    it('does not record a tracked sframe call', async () => {
      await createCall('ch-sf', ['sframe'])
      await handler.executeCommands([
        { action: 'record', channelId: 'ch-sf', name: 'vm-2', maxDuration: 60, beep: false, callbackPath: '/cb' },
      ])
      expect(client.calls.filter((c) => c.method === 'recordChannel')).toHaveLength(0)
    })

    it('still records a tracked pstn call (voicemail keeps working)', async () => {
      await createCall('ch-pstn')
      await handler.executeCommands([
        { action: 'record', channelId: 'ch-pstn', name: 'vm-3', maxDuration: 60, beep: false, callbackPath: '/cb' },
      ])
      expect(client.calls.filter((c) => c.method === 'recordChannel')).toHaveLength(1)
    })
  })

  describe('bridge cleanup when the volunteer hangs up first', () => {
    async function bridged(callerId: string, volId: string, bridgeId: string) {
      client.bridge = (async (...args: unknown[]) => {
        client.calls.push({ method: 'bridge', args })
        return bridgeId
      }) as BridgeClient['bridge']
      await createCall(callerId)
      await handler.executeCommands([
        { action: 'bridge', callerChannelId: callerId, volunteerChannelId: volId, record: false },
      ])
    }

    it('hangs up the caller leg, destroys the bridge and drops the entry', async () => {
      await bridged('ch-caller', 'ch-vol', 'br-1')
      expect(handler.getStatus().activeBridges).toBe(1)

      // The volunteer channel is never in `calls` — this used to skip cleanupBridge entirely.
      await hangup('ch-vol')

      expect(handler.getStatus().activeBridges).toBe(0)
      expect(client.calls).toContainEqual({ method: 'hangup', args: ['ch-caller'] })
      expect(client.calls).toContainEqual({ method: 'destroyBridge', args: ['br-1'] })
    })

    it('removes every bridge entry a channel appears in, not just the first', async () => {
      await bridged('ch-caller', 'ch-vol', 'br-1')
      client.bridge = (async () => 'br-2') as BridgeClient['bridge']
      await handler.executeCommands([
        { action: 'bridge', callerChannelId: 'ch-caller', volunteerChannelId: 'ch-vol-2', record: false },
      ])
      expect(handler.getStatus().activeBridges).toBe(2)

      await hangup('ch-caller')

      expect(handler.getStatus().activeBridges).toBe(0)
      expect(client.calls).toContainEqual({ method: 'destroyBridge', args: ['br-1'] })
      expect(client.calls).toContainEqual({ method: 'destroyBridge', args: ['br-2'] })
    })
  })

  describe('gather timeouts', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('a superseded gather timeout cannot fire against the newer gather', async () => {
      await createCall('ch-g')
      await handler.executeCommands([
        { action: 'gather', channelId: 'ch-g', numDigits: 1, timeout: 5, callbackPath: '/first' },
      ])
      await handler.executeCommands([
        { action: 'gather', channelId: 'ch-g', numDigits: 1, timeout: 20, callbackPath: '/second' },
      ])

      await vi.advanceTimersByTimeAsync(6_000)
      // The first gather's 5s timer must have been cancelled — nothing sent yet.
      expect(webhook.sentWebhooks.filter((w) => w.path === '/first')).toHaveLength(0)
      expect(webhook.sentWebhooks.filter((w) => w.path === '/second')).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(15_000)
      expect(webhook.sentWebhooks.filter((w) => w.path === '/second')).toHaveLength(1)
      expect(webhook.sentWebhooks.filter((w) => w.path === '/first')).toHaveLength(0)
    })
  })

  describe('PBX reconciliation after a connection reset', () => {
    const reset = () => handler.handleEvent({ type: 'connection_reset', timestamp: new Date().toISOString() })

    async function queuedCaller(channelId: string) {
      await createCall(channelId)
      await handler.executeCommands([
        {
          action: 'queue',
          channelId,
          exitCallbackPath: '/api/telephony/queue-exit',
          callbackParams: { hubId: 'h' },
        },
      ])
    }

    it('tears down a queued caller whose channel vanished while events were lost', async () => {
      await queuedCaller('ch-gone')
      await queuedCaller('ch-alive')
      client.listChannels = (async () => [{ id: 'ch-alive', state: 'Up', caller: '+1' }]) as BridgeClient['listChannels']

      await reset()

      // The vanished caller's queue-exit webhook fired and its state is gone...
      const exits = webhook.sentWebhooks.filter((w) => w.path === '/api/telephony/queue-exit')
      expect(exits).toHaveLength(1)
      expect(exits[0].payload).toMatchObject({ channelId: 'ch-gone', queueResult: 'hangup' })
      // ...while the caller that is still on the PBX keeps its state.
      expect(handler.getStatus()).toMatchObject({ activeCalls: 1, activeQueues: 1, untrackedChannels: 0 })
    })

    it('tears down all tracked state and hangs the channels up when the PBX cannot be enumerated', async () => {
      await queuedCaller('ch-a')
      client.listChannels = (async () => {
        throw new Error('pbx unreachable')
      }) as BridgeClient['listChannels']

      await reset()

      expect(handler.getStatus()).toMatchObject({ activeCalls: 0, activeQueues: 0 })
      expect(client.calls).toContainEqual({ method: 'hangup', args: ['ch-a'] })
    })

    it('reports live channels it holds no state for instead of silently ignoring them', async () => {
      client.listChannels = (async () => [
        { id: 'orphan-1', state: 'Up', caller: '+1' },
        { id: 'orphan-2', state: 'Up', caller: '+2' },
      ]) as BridgeClient['listChannels']

      await reset()

      expect(handler.getStatus().untrackedChannels).toBe(2)
      // Not hung up: on Asterisk the channel list includes channels this bridge does not own.
      expect(client.calls.filter((c) => c.method === 'hangup')).toHaveLength(0)
    })

    it('does not tear down a call that begins while the channel list is in flight', async () => {
      let release: (v: Array<{ id: string; state: string; caller: string }>) => void = () => {}
      client.listChannels = (() =>
        new Promise((resolve) => {
          release = resolve
        })) as BridgeClient['listChannels']

      const pending = reset()
      await createCall('ch-new') // arrives after the snapshot request, before the reply
      release([]) // ...and is therefore absent from the (stale) listing
      await pending

      expect(handler.getStatus().activeCalls).toBe(1)
    })

    it('tears down a ringing volunteer leg that vanished and reports call-status', async () => {
      await createCall('ch-caller')
      await handler.executeCommands([
        {
          action: 'ring',
          endpoint: 'PJSIP/100@trunk',
          callerId: '+1',
          timeout: 30,
          answerCallbackPath: '/a',
          answerCallbackParams: { parentCallSid: 'ch-caller', pubkey: 'pk1' },
          statusCallbackPath: '/s',
        },
      ])
      expect(handler.getStatus().ringingChannels).toBe(1)
      client.listChannels = (async () => [{ id: 'ch-caller', state: 'Up', caller: '+1' }]) as BridgeClient['listChannels']

      await reset()

      expect(handler.getStatus()).toMatchObject({ activeCalls: 1, ringingChannels: 0 })
      expect(webhook.sentWebhooks.some((w) => w.path === '/api/telephony/call-status')).toBe(true)
    })
  })

  // ================================================================
  // dispose
  // ================================================================

  describe('dispose', () => {
    it('cleans up background timers', () => {
      // Should not throw
      handler.dispose()
    })
  })
})
