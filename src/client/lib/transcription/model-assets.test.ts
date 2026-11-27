import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AssetIntegrityError,
  MODELS_BASE_PATH,
  ORT_BASE_PATH,
  configureOfflineEnv,
  createVerifiedCache,
  loadVerifiedModel,
  localRuntimePaths,
  manifest,
  modelPin,
  readVerified,
  verifyModelFiles,
  verifyRuntime,
  type AssetPin,
  type ModelPin,
  type OfflineEnv,
  type Sha256,
} from './model-assets'

const nodeSha256: Sha256 = async (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex')

const bytesOf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
const pinFor = (name: string, bytes: ArrayBuffer): AssetPin => ({
  path: name,
  sha256: createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
  bytes: bytes.byteLength,
})
const respond = (bytes: ArrayBuffer | null) => async () =>
  bytes ? new Response(bytes.slice(0), { status: 200 }) : new Response(null, { status: 404 })

describe('model manifest', () => {
  it('pins every selectable model to an exact upstream commit with all required files', () => {
    expect(Object.keys(manifest.models).sort()).toEqual(['base', 'base.en', 'tiny', 'tiny.en'])
    for (const [name, pin] of Object.entries(manifest.models)) {
      expect(pin.revision, `${name} revision`).toMatch(/^[0-9a-f]{40}$/)
      expect(pin.files.map((f) => f.path), `${name} files`).toEqual(
        expect.arrayContaining([
          'config.json',
          'generation_config.json',
          'preprocessor_config.json',
          'tokenizer.json',
          'tokenizer_config.json',
          'onnx/encoder_model_quantized.onnx',
          'onnx/decoder_model_merged_quantized.onnx',
        ]),
      )
      for (const file of pin.files) {
        expect(file.sha256, `${name}/${file.path}`).toMatch(/^[0-9a-f]{64}$/)
        expect(file.bytes).toBeGreaterThan(0)
      }
    }
    for (const file of manifest.runtime.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('pins the same onnxruntime-web the lockfile resolves', () => {
    const installed = JSON.parse(readFileSync('node_modules/onnxruntime-web/package.json', 'utf8')).version
    expect(manifest.runtime.version).toBe(installed)
  })
})

describe('readVerified', () => {
  const good = bytesOf('whisper')

  it('returns the bytes when length and sha256 match the pin', async () => {
    const out = await readVerified('/models/x', pinFor('x', good), respond(good), nodeSha256)
    expect(new TextDecoder().decode(out)).toBe('whisper')
  })

  it('rejects bytes whose digest differs from the pin', async () => {
    const tampered = bytesOf('whisPer')
    await expect(readVerified('/models/x', pinFor('x', good), respond(tampered), nodeSha256)).rejects.toThrow(
      /does not match the pinned/,
    )
  })

  it('rejects a truncated file before hashing it', async () => {
    await expect(
      readVerified('/models/x', pinFor('x', good), respond(bytesOf('whis')), nodeSha256),
    ).rejects.toThrow(/expected 7 bytes, got 4/)
  })

  it('treats a model that is not bundled as an error, never a fallback', async () => {
    await expect(readVerified('/models/x', pinFor('x', good), respond(null), nodeSha256)).rejects.toBeInstanceOf(
      AssetIntegrityError,
    )
  })
})

describe('loadVerifiedModel', () => {
  it('refuses an unknown model name instead of substituting another', async () => {
    await expect(loadVerifiedModel('large-v3', respond(null), nodeSha256)).rejects.toThrow(/not in the pinned manifest/)
    expect(() => modelPin('large-v3')).toThrow(AssetIntegrityError)
  })

  it('requests only same-origin /models/ URLs and fails if any pinned file is missing', async () => {
    const requested: string[] = []
    const fetcher = async (url: string) => {
      requested.push(url)
      return new Response(null, { status: 404 })
    }
    await expect(loadVerifiedModel('tiny.en', fetcher, nodeSha256)).rejects.toThrow(/not bundled/)
    expect(requested.length).toBeGreaterThan(0)
    for (const url of requested) {
      expect(url.startsWith(MODELS_BASE_PATH), url).toBe(true)
      expect(url).not.toMatch(/^[a-z]+:\/\//i)
    }
  })

  it('keys verified files by the URL the pipeline requests them by', async () => {
    const contents = new Map<string, ArrayBuffer>([
      ['config.json', bytesOf('{"a":1}')],
      ['onnx/encoder_model_quantized.onnx', bytesOf('encoder')],
    ])
    const pin: ModelPin = {
      repo: 'org/whisper-test',
      revision: 'a'.repeat(40),
      files: [...contents].map(([name, bytes]) => pinFor(name, bytes)),
    }
    const fetcher = async (url: string) => {
      const name = url.slice(`${MODELS_BASE_PATH}org/whisper-test/`.length)
      const bytes = contents.get(name)
      return bytes ? new Response(bytes.slice(0), { status: 200 }) : new Response(null, { status: 404 })
    }
    const verified = await verifyModelFiles(pin, fetcher, nodeSha256)
    expect([...verified.keys()].sort()).toEqual([
      '/models/org/whisper-test/config.json',
      '/models/org/whisper-test/onnx/encoder_model_quantized.onnx',
    ])
    const hit = await createVerifiedCache(verified).match('/models/org/whisper-test/config.json')
    expect(await hit?.text()).toBe('{"a":1}')
  })

  it('rejects the whole model when one file is tampered', async () => {
    const good = bytesOf('encoder')
    const pin: ModelPin = { repo: 'org/m', revision: 'b'.repeat(40), files: [pinFor('a.onnx', good)] }
    await expect(verifyModelFiles(pin, respond(bytesOf('evil!!!')), nodeSha256)).rejects.toThrow(AssetIntegrityError)
  })
})

describe('createVerifiedCache', () => {
  const verified = new Map<string, ArrayBuffer>([['/models/org/m/config.json', bytesOf('{}')]])
  const cache = createVerifiedCache(verified)

  it('serves verified bytes', async () => {
    const hit = await cache.match('/models/org/m/config.json')
    expect(await hit?.text()).toBe('{}')
  })

  it('misses on anything unverified — including a remote URL', async () => {
    expect(await cache.match('https://huggingface.co/org/m/resolve/main/config.json')).toBeUndefined()
    expect(await cache.match('/models/org/m/other.json')).toBeUndefined()
  })

  it('never persists anything', async () => {
    await cache.put()
    expect(verified.size).toBe(1)
  })
})

describe('configureOfflineEnv', () => {
  const cdn = (name: string) => `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.0.0/dist/${name}`
  const makeEnv = (mjs: string, wasm: string): OfflineEnv => ({
    allowRemoteModels: true,
    allowLocalModels: false,
    localModelPath: '/somewhere-else/',
    useBrowserCache: true,
    useCustomCache: false,
    customCache: null,
    useWasmCache: true,
    backends: { onnx: { wasm: { wasmPaths: { mjs: cdn(mjs), wasm: cdn(wasm) } } } },
  })

  it('disables remote models and the browser cache, and serves from verified bytes', () => {
    const env = makeEnv('ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm')
    configureOfflineEnv(env, new Map())
    expect(env.allowRemoteModels).toBe(false)
    expect(env.allowLocalModels).toBe(true)
    expect(env.localModelPath).toBe(MODELS_BASE_PATH)
    expect(env.useBrowserCache).toBe(false)
    expect(env.useCustomCache).toBe(true)
    expect(env.customCache).toBeTruthy()
  })

  it('moves the ONNX runtime off the CDN onto the pinned local copy, keeping the variant', () => {
    const env = makeEnv('ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm')
    const local = configureOfflineEnv(env, new Map())
    expect(local).toEqual({
      mjs: `${ORT_BASE_PATH}ort-wasm-simd-threaded.mjs`,
      wasm: `${ORT_BASE_PATH}ort-wasm-simd-threaded.wasm`,
    })
    expect(env.backends.onnx.wasm?.wasmPaths).toEqual(local)
  })

  it('refuses a runtime file that is not pinned', () => {
    expect(() =>
      localRuntimePaths({ mjs: cdn('ort-wasm-simd-threaded.jsep.mjs'), wasm: cdn('ort-wasm-simd-threaded.jsep.wasm') }),
    ).toThrow(/not in the pinned manifest/)
  })

  it('verifies the runtime files it will load', async () => {
    const requested: string[] = []
    const fetcher = async (url: string) => {
      requested.push(url)
      return new Response(null, { status: 404 })
    }
    await expect(
      verifyRuntime(
        { mjs: `${ORT_BASE_PATH}ort-wasm-simd-threaded.mjs`, wasm: `${ORT_BASE_PATH}ort-wasm-simd-threaded.wasm` },
        fetcher,
        nodeSha256,
      ),
    ).rejects.toThrow(AssetIntegrityError)
    expect(requested).toEqual([`${ORT_BASE_PATH}ort-wasm-simd-threaded.mjs`])
  })
})

/**
 * Structural guard: the transcription worker must route every load through the verified,
 * offline configuration, and no file in the client may name a model host or CDN.
 */
describe('no runtime path to a third-party model host', () => {
  const root = path.resolve(__dirname, '..', '..')
  const sources: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts')) sources.push(full)
    }
  }
  walk(root)

  it('scans the client sources', () => {
    expect(sources.length).toBeGreaterThan(50)
  })

  it('never names huggingface.co or a CDN in client code', () => {
    const offenders = sources.filter((f) => /huggingface\.co|cdn\.jsdelivr|unpkg\.com/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => path.relative(root, f))).toEqual([])
  })

  it('has the worker configure the offline env and verify before creating the pipeline', () => {
    const worker = readFileSync(path.join(root, 'lib/transcription/transcription-worker.ts'), 'utf8')
    const configured = worker.indexOf('configureOfflineEnv(')
    const verified = worker.indexOf('loadVerifiedModel(')
    const created = worker.indexOf("'automatic-speech-recognition'")
    expect(verified).toBeGreaterThan(-1)
    expect(configured).toBeGreaterThan(verified)
    expect(created).toBeGreaterThan(configured)
    expect(worker).not.toMatch(/allowRemoteModels\s*=\s*true/)
  })
})
