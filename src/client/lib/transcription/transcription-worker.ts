/**
 * Web Worker for client-side transcription using @huggingface/transformers.
 *
 * Runs Whisper ONNX model in single-threaded WASM mode (no SharedArrayBuffer
 * required). Audio chunks arrive from the AudioWorklet via the main thread;
 * transcription results are posted back.
 */
import {
  env,
  type AutomaticSpeechRecognitionPipeline,
  type AutomaticSpeechRecognitionOutput,
} from '@huggingface/transformers'
import {
  configureOfflineEnv,
  loadVerifiedModel,
  modelPin,
  verifyRuntime,
  type OfflineEnv,
} from './model-assets'

// Force single-threaded WASM — avoids SharedArrayBuffer / COEP requirement
// that would break Twilio Voice SDK
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1
}

// Models and the ONNX runtime ship inside the app and are verified against pinned SHA-256
// digests before use (#2951). Remote loading is disabled in `init` via configureOfflineEnv:
// the worker never contacts a model host or CDN, so a model download cannot reveal that this
// client transcribes and no unpinned model bytes are ever executed.

type WorkerMessage =
  | { type: 'init'; model: string; language: string }
  | { type: 'transcribe_chunk'; audio: ArrayBuffer; chunkIndex: number }
  | { type: 'finalize' }

let transcriber: AutomaticSpeechRecognitionPipeline | null = null
let modelLanguage = 'en'

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data

  switch (msg.type) {
    case 'init': {
      try {
        self.postMessage({ type: 'status', status: 'loading' })

        // `msg.model` selects a pinned entry in model-manifest.json; an unknown name is an error,
        // never a default — substituting another model would run bytes the user did not choose.
        const pin = modelPin(msg.model)
        modelLanguage = msg.language || 'en'

        // Read every file from the app's own origin and prove it matches its pin BEFORE the
        // pipeline sees it. A missing or tampered file fails here, loudly.
        const fetchLocal = (url: string) => fetch(url, { cache: 'no-store' })
        const verified = await loadVerifiedModel(msg.model, fetchLocal)
        const runtime = configureOfflineEnv(env as unknown as OfflineEnv, verified)
        await verifyRuntime(runtime, fetchLocal)

        // Dynamic import to avoid TypeScript union explosion from pipeline() overloads
        const { pipeline } = await import('@huggingface/transformers')
        transcriber = await (pipeline as (
          task: string,
          model: string,
          options: Record<string, unknown>,
        ) => Promise<AutomaticSpeechRecognitionPipeline>)(
          'automatic-speech-recognition',
          pin.repo,
          {
            dtype: 'q8',  // 8-bit quantized — best balance of size and quality for WASM
            device: 'wasm',
            progress_callback: (progress: { status: string; file?: string; progress?: number }) => {
              self.postMessage({
                type: 'progress',
                status: progress.status,
                file: progress.file,
                progress: progress.progress,
              })
            },
          },
        )

        self.postMessage({ type: 'ready' })
      } catch (error) {
        self.postMessage({
          type: 'error',
          error: error instanceof Error ? error.message : 'Failed to initialize transcription model',
        })
      }
      break
    }

    case 'transcribe_chunk': {
      if (!transcriber) {
        self.postMessage({
          type: 'error',
          error: 'Transcriber not initialized',
          chunkIndex: msg.chunkIndex,
        })
        return
      }

      try {
        const audio = new Float32Array(msg.audio)

        const result = await transcriber(audio, {
          language: modelLanguage === 'auto' ? undefined : modelLanguage,
          return_timestamps: true,
          chunk_length_s: 30,
          stride_length_s: 5,
        }) as AutomaticSpeechRecognitionOutput

        self.postMessage({
          type: 'chunk_result',
          chunkIndex: msg.chunkIndex,
          text: result.text,
          chunks: result.chunks,
        })
      } catch (error) {
        self.postMessage({
          type: 'error',
          error: error instanceof Error ? error.message : 'Transcription failed',
          chunkIndex: msg.chunkIndex,
        })
      }
      break
    }

    case 'finalize': {
      // Dispose of the pipeline to free memory (~89MB)
      if (transcriber) {
        await (transcriber as AutomaticSpeechRecognitionPipeline & { dispose?: () => Promise<void> }).dispose?.()
        transcriber = null
      }
      self.postMessage({ type: 'finalized' })
      break
    }
  }
}
