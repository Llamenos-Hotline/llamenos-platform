/**
 * Pinned, verified, bundled assets for client-side transcription (#2951).
 *
 * Whisper models and the ONNX runtime ship inside the app (`public/models/`, fetched at build
 * time by `scripts/whisper-models.ts`). At load the worker:
 *   1. refuses to reach any remote model host (`allowRemoteModels = false`) or CDN,
 *   2. reads every file the pipeline will use from the app's own origin,
 *   3. checks its SHA-256 and length against `model-manifest.json`, and
 *   4. hands the pipeline exactly the bytes it checked — a file that is missing or does not
 *      match the pin is an error, never a fallback.
 *
 * This module is pure (fetch and digest are injected) so it is unit-tested without a worker.
 */
import manifestJson from './model-manifest.json'

export type TranscriptionModel = 'tiny' | 'tiny.en' | 'base' | 'base.en'

export interface AssetPin {
  path: string
  sha256: string
  bytes: number
}

export interface ModelPin {
  repo: string
  revision: string
  files: AssetPin[]
}

interface Manifest {
  models: Record<TranscriptionModel, ModelPin>
  runtime: { package: string; version: string; files: AssetPin[] }
}

export const manifest = manifestJson as unknown as Manifest

/** Same-origin path the build installs models under; mirrors HF's `<repo>/<file>` layout. */
export const MODELS_BASE_PATH = '/models/'
/** Same-origin path of the pinned ONNX runtime files. */
export const ORT_BASE_PATH = '/models/ort/'

export class AssetIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetIntegrityError'
  }
}

export type Fetcher = (url: string) => Promise<Response>
export type Sha256 = (bytes: ArrayBuffer) => Promise<string>

export const webCryptoSha256: Sha256 = async (bytes) => {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function modelPin(model: string): ModelPin {
  const pin = (manifest.models as Record<string, ModelPin | undefined>)[model]
  if (!pin) throw new AssetIntegrityError(`Unknown transcription model "${model}" — it is not in the pinned manifest`)
  return pin
}

/** The local URL a model file is served from; this is also the key the pipeline looks it up by. */
export const modelFileUrl = (pin: ModelPin, file: string) => `${MODELS_BASE_PATH}${pin.repo}/${file}`

/** Fetch `url` from the app's own origin and prove it is the pinned asset. */
export async function readVerified(
  url: string,
  pin: AssetPin,
  fetcher: Fetcher,
  sha256: Sha256 = webCryptoSha256,
): Promise<ArrayBuffer> {
  const response = await fetcher(url)
  if (!response.ok) {
    throw new AssetIntegrityError(
      `${pin.path}: not bundled with this build (${response.status} from ${url}). Run \`bun run models:fetch\` and rebuild.`,
    )
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength !== pin.bytes) {
    throw new AssetIntegrityError(`${pin.path}: expected ${pin.bytes} bytes, got ${bytes.byteLength}`)
  }
  const actual = await sha256(bytes)
  if (actual !== pin.sha256) {
    throw new AssetIntegrityError(`${pin.path}: sha256 ${actual} does not match the pinned ${pin.sha256}`)
  }
  return bytes
}

/** Every file of `model`, verified, keyed by the URL the pipeline requests it by. */
export async function loadVerifiedModel(
  model: string,
  fetcher: Fetcher,
  sha256: Sha256 = webCryptoSha256,
): Promise<Map<string, ArrayBuffer>> {
  return verifyModelFiles(modelPin(model), fetcher, sha256)
}

export async function verifyModelFiles(
  pin: ModelPin,
  fetcher: Fetcher,
  sha256: Sha256 = webCryptoSha256,
): Promise<Map<string, ArrayBuffer>> {
  const verified = new Map<string, ArrayBuffer>()
  for (const file of pin.files) {
    const url = modelFileUrl(pin, file.path)
    verified.set(url, await readVerified(url, file, fetcher, sha256))
  }
  return verified
}

export interface RuntimePaths {
  mjs: string
  wasm: string
}

const basename = (url: string) => url.slice(url.lastIndexOf('/') + 1)

/**
 * Re-point the wasm paths transformers.js chose (a jsdelivr CDN URL by default) at the app's
 * own pinned copy of the same file. Keeps transformers.js's choice of runtime variant (it
 * depends on the browser) but never its host. A file with no pin is an error.
 */
export function localRuntimePaths(chosen: RuntimePaths): RuntimePaths {
  const pinned = new Set(manifest.runtime.files.map((f) => f.path))
  const local = (url: string) => {
    const name = basename(url)
    if (!pinned.has(name)) throw new AssetIntegrityError(`ONNX runtime file "${name}" is not in the pinned manifest`)
    return `${ORT_BASE_PATH}${name}`
  }
  return { mjs: local(chosen.mjs), wasm: local(chosen.wasm) }
}

/** Verify the two pinned ONNX runtime files the wasm backend will load. */
export async function verifyRuntime(
  paths: RuntimePaths,
  fetcher: Fetcher,
  sha256: Sha256 = webCryptoSha256,
): Promise<void> {
  for (const url of [paths.mjs, paths.wasm]) {
    const pin = manifest.runtime.files.find((f) => f.path === basename(url))
    if (!pin) throw new AssetIntegrityError(`ONNX runtime file "${basename(url)}" is not in the pinned manifest`)
    await readVerified(url, pin, fetcher, sha256)
  }
}

/**
 * A `Cache`-shaped object for transformers.js (`env.customCache`) that only ever answers with
 * bytes that already passed [loadVerifiedModel]. It reads nothing from the network and stores
 * nothing: an unknown key is a miss, and with remote models disabled a miss is an error.
 */
export function createVerifiedCache(verified: Map<string, ArrayBuffer>) {
  return {
    async match(request: string | Request): Promise<Response | undefined> {
      const key = typeof request === 'string' ? request : request.url
      const bytes = verified.get(key)
      if (!bytes) return undefined
      return new Response(bytes.slice(0), {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      })
    },
    async put(): Promise<void> {
      // Verified assets are immutable and already in memory — nothing is persisted.
    },
  }
}

/**
 * The slice of transformers.js's `env` this module configures. Declared structurally so the
 * unit test can pass a plain object, and so a typo in a key is a compile error.
 */
export interface OfflineEnv {
  allowRemoteModels: boolean
  allowLocalModels: boolean
  localModelPath: string
  useBrowserCache: boolean
  useCustomCache: boolean
  customCache: unknown
  useWasmCache: boolean
  backends: { onnx: { wasm?: { wasmPaths?: unknown; numThreads?: number } } }
}

/**
 * Make transformers.js incapable of reaching a model host or CDN: no remote models, no
 * browser cache, and the ONNX runtime resolved from the app's own pinned files rather than
 * jsdelivr. Called before any pipeline is created; returns the runtime files to verify.
 */
export function configureOfflineEnv(env: OfflineEnv, verifiedModel: Map<string, ArrayBuffer>): RuntimePaths {
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = MODELS_BASE_PATH
  env.useBrowserCache = false
  env.useCustomCache = true
  env.customCache = createVerifiedCache(verifiedModel)
  env.useWasmCache = false
  const wasm = env.backends.onnx.wasm
  const chosen = wasm?.wasmPaths as RuntimePaths | undefined
  if (!wasm || !chosen?.mjs || !chosen.wasm) {
    throw new AssetIntegrityError('ONNX wasm backend is not configured with explicit runtime paths')
  }
  const local = localRuntimePaths(chosen)
  wasm.wasmPaths = local
  return local
}
