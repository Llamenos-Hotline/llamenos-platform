#!/usr/bin/env bun
/**
 * Whisper model assets for client-side transcription (#2951).
 *
 * The desktop client transcribes with transformers.js. It must never fetch a model (or the
 * ONNX runtime) from a third party at runtime: the download tells a host that this client
 * transcribes, and it runs bytes that nobody pinned. Instead the assets are fetched HERE, at
 * build time, from an exact upstream commit, checked against the SHA-256 in
 * `src/client/lib/transcription/model-manifest.json`, and shipped inside the app under
 * `public/models/`. The worker re-verifies every file at load.
 *
 *   bun scripts/whisper-models.ts fetch   (default) download + verify into public/models
 *   bun scripts/whisper-models.ts pin     recompute hashes from upstream, rewrite the manifest
 *
 * `fetch` fails loudly on any mismatch — a changed upstream file, a truncated download or a
 * different onnxruntime-web version never produces a model the app would run.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface AssetPin {
  path: string
  sha256: string
  bytes: number
}
interface ModelPin {
  repo: string
  revision: string
  files: AssetPin[]
}
interface Manifest {
  $comment: string
  models: Record<string, ModelPin>
  runtime: { package: string; version: string; files: AssetPin[] }
}

const ROOT = path.resolve(import.meta.dir, '..')
const MANIFEST_PATH = path.join(ROOT, 'src/client/lib/transcription/model-manifest.json')
const OUT_DIR = path.join(ROOT, 'public/models')
const ORT_DIST = path.join(ROOT, 'node_modules/onnxruntime-web/dist')

/** Exactly the files transformers.js requests for `automatic-speech-recognition` at dtype q8. */
const MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
]

/** The .mjs/.wasm pairs transformers.js selects for `device: 'wasm'` (asyncify; plain for old Safari). */
const RUNTIME_FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
]

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as Manifest
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

const upstreamUrl = (pin: ModelPin, file: string) =>
  `https://huggingface.co/${pin.repo}/resolve/${pin.revision}/${file}`

async function installedOrtVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'node_modules/onnxruntime-web/package.json'), 'utf8'))
  return pkg.version as string
}

async function writeAtomic(dest: string, bytes: Uint8Array) {
  await mkdir(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  await writeFile(tmp, bytes)
  await rename(tmp, dest)
}

async function pin() {
  const manifest = await readManifest()
  for (const [name, model] of Object.entries(manifest.models)) {
    model.files = []
    for (const file of MODEL_FILES) {
      const bytes = await download(upstreamUrl(model, file))
      model.files.push({ path: file, sha256: sha256(bytes), bytes: bytes.length })
      console.log(`pinned ${name}/${file} ${bytes.length}`)
    }
  }
  const version = await installedOrtVersion()
  manifest.runtime = { package: 'onnxruntime-web', version, files: [] }
  for (const file of RUNTIME_FILES) {
    const bytes = new Uint8Array(await readFile(path.join(ORT_DIST, file)))
    manifest.runtime.files.push({ path: file, sha256: sha256(bytes), bytes: bytes.length })
    console.log(`pinned ort/${file} ${bytes.length}`)
  }
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function ensure(dest: string, expected: AssetPin, obtain: () => Promise<Uint8Array>) {
  try {
    const existing = new Uint8Array(await readFile(dest))
    if (existing.length === expected.bytes && sha256(existing) === expected.sha256) return
  } catch {
    // missing — fetch below
  }
  const bytes = await obtain()
  const actual = sha256(bytes)
  if (bytes.length !== expected.bytes || actual !== expected.sha256) {
    throw new Error(
      `${expected.path}: expected sha256 ${expected.sha256} (${expected.bytes} bytes), got ${actual} (${bytes.length} bytes). ` +
        'Refusing to install an asset that does not match the manifest pin.',
    )
  }
  await writeAtomic(dest, bytes)
  console.log(`installed ${path.relative(ROOT, dest)}`)
}

async function fetchAll() {
  const manifest = await readManifest()
  const unpinned = Object.entries(manifest.models).filter(([, m]) => m.files.length === 0)
  if (unpinned.length > 0 || manifest.runtime.files.length === 0) {
    throw new Error('model-manifest.json has unpinned entries — run `bun run models:pin` and commit the result.')
  }
  const version = await installedOrtVersion()
  if (version !== manifest.runtime.version) {
    throw new Error(
      `onnxruntime-web is ${version} but the manifest pins ${manifest.runtime.version}. ` +
        'Run `bun run models:pin` to re-pin the runtime files.',
    )
  }
  for (const model of Object.values(manifest.models)) {
    for (const file of model.files) {
      await ensure(path.join(OUT_DIR, model.repo, file.path), file, () => download(upstreamUrl(model, file.path)))
    }
  }
  for (const file of manifest.runtime.files) {
    await ensure(path.join(OUT_DIR, 'ort', file.path), file, async () => new Uint8Array(await readFile(path.join(ORT_DIST, file.path))))
  }
  console.log(
    `models ready in ${path.relative(ROOT, OUT_DIR)} ` +
      `(${Object.keys(manifest.models).length} models, ${manifest.runtime.files.length} runtime files)`,
  )
}

const command = process.argv[2] ?? 'fetch'
if (command === 'pin') await pin()
else if (command === 'fetch') await fetchAll()
else {
  console.error(`unknown command: ${command} (expected fetch | pin)`)
  process.exit(2)
}
