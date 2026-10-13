import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTranscriptionService } from '@worker/lib/transcription-client'

describe('transcription-client', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let originalWhisperUrl: string | undefined

  beforeEach(() => {
    originalWhisperUrl = process.env.WHISPER_URL
    delete process.env.WHISPER_URL
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: 'hello world' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    if (originalWhisperUrl !== undefined) {
      process.env.WHISPER_URL = originalWhisperUrl
    } else {
      delete process.env.WHISPER_URL
    }
  })

  describe('URL validation', () => {
    it('accepts localhost', () => {
      expect(() => createTranscriptionService({ whisperUrl: 'http://localhost:8080/v1/audio/transcriptions' })).not.toThrow()
    })

    it('accepts 127.0.0.1', () => {
      expect(() => createTranscriptionService({ whisperUrl: 'http://127.0.0.1:8080/v1/audio/transcriptions' })).not.toThrow()
    })

    it('accepts Docker Compose service names', () => {
      expect(() => createTranscriptionService({ whisperUrl: 'http://whisper:8080/v1/audio/transcriptions' })).not.toThrow()
    })

    it('accepts private IP 10.x.x.x', () => {
      expect(() => createTranscriptionService({ whisperUrl: 'http://10.0.0.5:8080/v1/audio/transcriptions' })).not.toThrow()
    })

    it('accepts private IP 172.16.x.x', () => {
      expect(() => createTranscriptionService({ whisperUrl: 'http://172.16.0.1:8080/v1/audio/transcriptions' })).not.toThrow()
    })

    it('accepts private IP 172.31.x.x', () => {
      expect(() => createTranscriptionService({ whisperUrl: 'http://172.31.255.1:8080/v1/audio/transcriptions' })).not.toThrow()
    })

    it('accepts private IP 192.168.x.x', () => {
      expect(() => createTranscriptionService({ whisperUrl: 'http://192.168.1.50:8080/v1/audio/transcriptions' })).not.toThrow()
    })

    it('rejects public hostnames', () => {
      expect(() => createTranscriptionService({ whisperUrl: 'http://example.com/v1/audio/transcriptions' })).toThrow(
        'Whisper URL must point to a trusted internal host'
      )
    })

    it('rejects public IPs', () => {
      expect(() => createTranscriptionService({ whisperUrl: 'http://8.8.8.8:8080/v1/audio/transcriptions' })).toThrow(
        'Whisper URL must point to a trusted internal host'
      )
    })

    it('rejects unsupported protocols', () => {
      expect(() => createTranscriptionService({ whisperUrl: 'ftp://localhost/file' })).toThrow('Unsupported protocol')
    })

    it('rejects invalid URLs', () => {
      expect(() => createTranscriptionService({ whisperUrl: 'not a url' })).toThrow('Invalid Whisper URL')
    })
  })

  describe('service creation', () => {
    it('uses opts.whisperUrl when provided', () => {
      const service = createTranscriptionService({ whisperUrl: 'http://localhost:9000/transcribe' })
      expect(service).toBeDefined()
      expect(typeof service.run).toBe('function')
    })

    it('falls back to WHISPER_URL env var', () => {
      process.env.WHISPER_URL = 'http://whisper:8080/v1/audio/transcriptions'
      const service = createTranscriptionService()
      expect(service).toBeDefined()
    })

    it('falls back to default localhost URL', () => {
      delete process.env.WHISPER_URL
      const service = createTranscriptionService()
      expect(service).toBeDefined()
    })
  })

  describe('run transcription', () => {
    it('sends audio as multipart form data', async () => {
      const service = createTranscriptionService({ whisperUrl: 'http://localhost:8080/v1/audio/transcriptions' })
      const audio = [1, 2, 3, 4, 5]
      await service.run('Systran/faster-whisper-base', { audio })

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, init] = fetchSpy.mock.calls[0]
      expect(url).toBe('http://localhost:8080/v1/audio/transcriptions')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeInstanceOf(FormData)
    })

    it('returns transcription text', async () => {
      const service = createTranscriptionService({ whisperUrl: 'http://localhost:8080/v1/audio/transcriptions' })
      const result = await service.run('Systran/faster-whisper-base', { audio: [1, 2, 3] })
      expect(result.text).toBe('hello world')
    })

    it('throws on non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' })
      )
      const service = createTranscriptionService({ whisperUrl: 'http://localhost:8080/v1/audio/transcriptions' })
      await expect(service.run('Systran/faster-whisper-base', { audio: [1] })).rejects.toThrow(
        'Whisper transcription failed: 500 Internal Server Error'
      )
    })

    it('uses the model parameter in the request', async () => {
      const service = createTranscriptionService({ whisperUrl: 'http://localhost:8080/v1/audio/transcriptions' })
      await service.run('custom-model-v2', { audio: [1, 2] })

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [, init] = fetchSpy.mock.calls[0]
      const body = init?.body as FormData
      expect(body.get('model')).toBe('custom-model-v2')
    })

    it('defaults model when empty string passed', async () => {
      const service = createTranscriptionService({ whisperUrl: 'http://localhost:8080/v1/audio/transcriptions' })
      await service.run('', { audio: [1] })

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [, init] = fetchSpy.mock.calls[0]
      const body = init?.body as FormData
      expect(body.get('model')).toBe('Systran/faster-whisper-base')
    })

    it('converts number array to Uint8Array', async () => {
      const service = createTranscriptionService({ whisperUrl: 'http://localhost:8080/v1/audio/transcriptions' })
      const audio = [0, 1, 2, 255]
      await service.run('Systran/faster-whisper-base', { audio })

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [, init] = fetchSpy.mock.calls[0]
      const body = init?.body as FormData
      const blob = body.get('file') as Blob
      expect(blob).toBeInstanceOf(Blob)
      expect(blob.type).toBe('audio/wav')
      const arrayBuffer = await blob.arrayBuffer()
      const view = new Uint8Array(arrayBuffer)
      expect(Array.from(view)).toEqual(audio)
    })

    it('handles empty transcription response gracefully', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ text: '' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
      const service = createTranscriptionService({ whisperUrl: 'http://localhost:8080/v1/audio/transcriptions' })
      const result = await service.run('Systran/faster-whisper-base', { audio: [1] })
      expect(result.text).toBe('')
    })
  })
})
