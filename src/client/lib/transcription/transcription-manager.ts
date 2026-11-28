/**
 * Client-side transcription manager.
 *
 * Orchestrates: AudioWorklet (microphone capture) → Web Worker (Whisper ONNX)
 * → transcript segments → concatenated final text.
 *
 * Audio never leaves the device — only the encrypted transcript is uploaded.
 * Captures LOCAL microphone only (Twilio SDK doesn't expose remote audio).
 *
 * Memory budget: ~96MB peak (WASM + model + ring buffer + in-flight chunk).
 */

import i18next from 'i18next'

import type { TranscriptionModel } from './model-assets'

export type { TranscriptionModel }

export type TranscriptionStatus =
  | 'idle'
  | 'loading'        // Verifying and initializing the bundled model
  | 'ready'          // Model loaded, waiting to start
  | 'capturing'      // Audio capture active, transcribing chunks
  | 'finalizing'     // Final chunk processing
  | 'done'           // Transcript ready
  | 'error'

export interface TranscriptionProgress {
  status: string
  file?: string
  progress?: number
}

export interface TranscriptionManagerOptions {
  model?: TranscriptionModel
  language?: string
  onStatusChange?: (status: TranscriptionStatus) => void
  onProgress?: (progress: TranscriptionProgress) => void
  onSegment?: (chunkIndex: number, text: string) => void
  onError?: (error: string) => void
}

export class TranscriptionManager {
  private worker: Worker | null = null
  private audioContext: AudioContext | null = null
  private captureNode: AudioWorkletNode | null = null
  private mediaStream: MediaStream | null = null
  private segments = new Map<number, string>()
  private chunkIndex = 0
  private pendingChunks = new Set<number>()
  private status: TranscriptionStatus = 'idle'
  private finalizeResolve: ((text: string) => void) | null = null
  private options: TranscriptionManagerOptions

  constructor(options: TranscriptionManagerOptions = {}) {
    this.options = options
  }

  private setStatus(status: TranscriptionStatus) {
    this.status = status
    this.options.onStatusChange?.(status)
  }

  getStatus(): TranscriptionStatus {
    return this.status
  }

  /**
   * Check if the browser supports client-side transcription.
   */
  static isSupported(): boolean {
    return (
      typeof WebAssembly === 'object' &&
      typeof AudioWorkletNode !== 'undefined' &&
      typeof Worker !== 'undefined'
    )
  }

  /**
   * Initialize the transcription model. The model ships inside the app and is verified
   * against its pinned SHA-256 at load; nothing is downloaded and no model host is contacted.
   */
  async initialize(): Promise<void> {
    if (this.status !== 'idle' && this.status !== 'error') return

    this.setStatus('loading')

    try {
      // Create Web Worker — Vite handles the URL transform for worker imports
      const worker = new Worker(
        new URL('./transcription-worker.ts', import.meta.url),
        { type: 'module' },
      )
      this.worker = worker

      // Set up message handler
      worker.onmessage = (event) => this.handleWorkerMessage(event.data)
      worker.onerror = (event) => {
        this.setStatus('error')
        this.options.onError?.(event.message || 'Worker error')
      }

      // Initialize the model in the worker
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Model initialization timed out')), 120_000) // verify + load bundled model
        const originalHandler = worker.onmessage
        worker.onmessage = (event) => {
          const msg = event.data
          if (msg.type === 'ready') {
            clearTimeout(timeout)
            worker.onmessage = originalHandler
            resolve()
          } else if (msg.type === 'error') {
            clearTimeout(timeout)
            reject(new Error(msg.error))
          } else if (msg.type === 'progress' || msg.type === 'status') {
            // Forward progress during init
            originalHandler?.call(worker, event)
          }
        }

        worker.postMessage({
          type: 'init',
          model: this.options.model || 'tiny.en',
          language: this.options.language || 'en',
        })
      })

      this.setStatus('ready')
    } catch (error) {
      this.setStatus('error')
      this.options.onError?.(error instanceof Error ? error.message : i18next.t('transcription.initializationFailed'))
      throw error
    }
  }

  /**
   * Start capturing local microphone audio and transcribing in 30-second chunks.
   */
  async startCapture(): Promise<void> {
    if (this.status !== 'ready') {
      throw new Error(`Cannot start capture in status: ${this.status}`)
    }

    try {
      // Request local microphone — volunteer's speech only
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })

      this.audioContext = new AudioContext({ sampleRate: 16000 })

      // Load AudioWorklet processor
      await this.audioContext.audioWorklet.addModule('/worklets/audio-capture-worklet.js')

      this.captureNode = new AudioWorkletNode(
        this.audioContext,
        'audio-capture-processor',
      )

      // Handle audio chunks from worklet → forward to transcription worker
      this.captureNode.port.onmessage = (event: MessageEvent) => {
        if (event.data.type === 'audio_chunk' && this.worker) {
          const chunk = this.chunkIndex++
          this.pendingChunks.add(chunk)
          this.worker.postMessage(
            {
              type: 'transcribe_chunk',
              audio: event.data.data.buffer,
              chunkIndex: chunk,
            },
            [event.data.data.buffer], // Transfer ownership
          )
        }
      }

      // Connect: microphone → AudioWorklet capture node
      const source = this.audioContext.createMediaStreamSource(this.mediaStream)
      source.connect(this.captureNode)
      // Don't connect to destination — we don't want to play back the mic

      this.setStatus('capturing')
    } catch (error) {
      this.setStatus('error')
      this.options.onError?.(error instanceof Error ? error.message : i18next.t('transcription.microphoneAccessDenied'))
      throw error
    }
  }

  /**
   * Stop capturing and return the full concatenated transcript.
   * Flushes remaining audio and waits for all pending chunks to complete.
   */
  async finalize(): Promise<string> {
    if (this.status !== 'capturing') {
      return this.getTranscript()
    }

    this.setStatus('finalizing')

    // Tell worklet to flush remaining audio
    this.captureNode?.port.postMessage({ type: 'stop' })

    // Stop microphone
    this.mediaStream?.getTracks().forEach(track => track.stop())

    // Wait for all pending transcription chunks to complete
    if (this.pendingChunks.size > 0) {
      await new Promise<string>((resolve) => {
        this.finalizeResolve = resolve
      })
    }

    const transcript = this.getTranscript()
    this.setStatus('done')
    return transcript
  }

  /**
   * Get the current transcript (may be partial if capture is still active).
   */
  getTranscript(): string {
    return Array.from(this.segments.entries())
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text.trim())
      .filter(Boolean)
      .join(' ')
  }

  /**
   * Stop everything and free resources (~89MB).
   */
  async dispose(): Promise<void> {
    // Stop audio capture
    this.captureNode?.port.postMessage({ type: 'stop' })
    this.mediaStream?.getTracks().forEach(track => track.stop())

    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close()
    }

    // Tell worker to dispose the model and free memory
    if (this.worker) {
      this.worker.postMessage({ type: 'finalize' })
      // Give it a moment to clean up, then terminate
      await new Promise(resolve => setTimeout(resolve, 500))
      this.worker.terminate()
    }

    this.worker = null
    this.audioContext = null
    this.captureNode = null
    this.mediaStream = null
    this.segments.clear()
    this.pendingChunks.clear()
    this.chunkIndex = 0
    this.finalizeResolve = null
    this.setStatus('idle')
  }

  private handleWorkerMessage(msg: Record<string, unknown>) {
    switch (msg.type) {
      case 'progress':
        this.options.onProgress?.({
          status: msg.status as string,
          file: msg.file as string | undefined,
          progress: msg.progress as number | undefined,
        })
        break

      case 'chunk_result': {
        const chunkIdx = msg.chunkIndex as number
        this.segments.set(chunkIdx, msg.text as string)
        this.pendingChunks.delete(chunkIdx)
        this.options.onSegment?.(chunkIdx, msg.text as string)

        // If we're finalizing and all chunks are done, resolve
        if (this.status === 'finalizing' && this.pendingChunks.size === 0 && this.finalizeResolve) {
          this.finalizeResolve(this.getTranscript())
          this.finalizeResolve = null
        }
        break
      }

      case 'error':
        this.options.onError?.(msg.error as string)
        if (msg.chunkIndex !== undefined) {
          this.pendingChunks.delete(msg.chunkIndex as number)
          // If finalizing and this was the last pending chunk, resolve with what we have
          if (this.status === 'finalizing' && this.pendingChunks.size === 0 && this.finalizeResolve) {
            this.finalizeResolve(this.getTranscript())
            this.finalizeResolve = null
          }
        }
        break
    }
  }
}
