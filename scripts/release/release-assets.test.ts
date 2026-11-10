// scripts/release/release-assets.sh, executed for real (bash + curl + jq)
// against a local server standing in for the GitHub Releases API — one that
// fails the way GitHub did when it stranded v0.21.4 and v0.21.9 as drafts:
// an upload 500 that leaves a "starter" stub behind, a download stream cut
// mid-transfer, a create or publish that lands but whose response is lost.
//
// The server implements the endpoints the helper uses and GitHub's semantics
// for them that matter here: drafts are invisible except through the list,
// assets carry GitHub's sha256 `digest`, an asset name already attached is
// rejected with 422 `already_exists`, and asset bytes are served behind a 302.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HELPER = join(import.meta.dir, 'release-assets.sh')
const REPO = 'acme/hotline'

interface Asset {
  id: number
  name: string
  state: 'uploaded' | 'starter'
  bytes: Uint8Array<ArrayBuffer>
}
interface Release {
  id: number
  tag_name: string
  name: string
  body: string
  draft: boolean
  prerelease: boolean
  make_latest?: string
  target_commitish?: string
  assets: Asset[]
}

const sha256 = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex')

let work: string
let server: ReturnType<typeof Bun.serve>
let releases: Release[]
let nextId: number
/** Every request the helper made, as `METHOD /path`. */
let log: string[]
/** Fault injection: return a Response to answer with it instead (state may already have changed). */
let fault: (method: string, path: string, url: URL) => Response | 'cut-stream' | 'truncate' | undefined

const base = () => `http://127.0.0.1:${server.port}`
const count = (prefix: string) => log.filter((l) => l.startsWith(prefix)).length
const serverError = () => new Response('{"message":"Server Error"}', { status: 500 })

function assetJson(a: Asset) {
  return {
    id: a.id,
    name: a.name,
    size: a.bytes.length,
    state: a.state,
    // GitHub only computes a digest for a finished upload.
    digest: a.state === 'uploaded' ? `sha256:${sha256(a.bytes)}` : null,
    url: `${base()}/repos/${REPO}/releases/assets/${a.id}`,
  }
}

function releaseJson(r: Release) {
  return {
    id: r.id,
    tag_name: r.tag_name,
    name: r.name,
    draft: r.draft,
    prerelease: r.prerelease,
    html_url: `https://github.com/${REPO}/releases/tag/${r.tag_name}`,
    upload_url: `${base()}/uploads/repos/${REPO}/releases/${r.id}/assets{?name,label}`,
    assets: r.assets.map(assetJson),
  }
}

function page<T>(items: T[], url: URL): Response {
  const per = Number(url.searchParams.get('per_page') ?? 30)
  const n = Number(url.searchParams.get('page') ?? 1)
  return Response.json(items.slice((n - 1) * per, n * per))
}

function addRelease(r: Partial<Release> & { tag_name: string }): Release {
  const rel: Release = { id: nextId++, name: r.tag_name, body: '', draft: true, prerelease: false, assets: [], ...r }
  releases.unshift(rel) // the list endpoint is newest-first
  return rel
}

function addAsset(rel: Release, name: string, bytes: Uint8Array<ArrayBuffer>, state: Asset['state'] = 'uploaded'): Asset {
  const a = { id: nextId++, name, state, bytes }
  rel.assets.push(a)
  return a
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const p = url.pathname
  const m = req.method
  log.push(`${m} ${p}`)
  if (req.headers.get('authorization') !== 'Bearer test-token') return new Response('bad credentials', { status: 401 })

  const injected = fault(m, p, url)
  if (injected instanceof Response) return injected

  const R = `/repos/${REPO}/releases`
  let g: RegExpMatchArray | null

  if (m === 'GET' && p === R) return page(releases.map(releaseJson), url)
  if (m === 'POST' && p === R) {
    const b = (await req.json()) as Partial<Release> & { tag_name: string }
    if (releases.some((r) => r.tag_name === b.tag_name && !r.draft))
      return Response.json({ message: 'Validation Failed', errors: [{ code: 'already_exists' }] }, { status: 422 })
    return Response.json(releaseJson(addRelease({ ...b, assets: [] })), { status: 201 })
  }
  if ((g = p.match(new RegExp(`^${R}/(\\d+)$`)))) {
    const rel = releases.find((r) => r.id === Number(g![1]))
    if (!rel) return new Response('{"message":"Not Found"}', { status: 404 })
    if (m === 'DELETE') {
      releases = releases.filter((r) => r !== rel)
      return new Response(null, { status: 204 })
    }
    if (m === 'PATCH') {
      Object.assign(rel, await req.json())
      return Response.json(releaseJson(rel))
    }
  }
  if (m === 'GET' && (g = p.match(new RegExp(`^${R}/(\\d+)/assets$`)))) {
    const rel = releases.find((r) => r.id === Number(g![1]))
    return rel ? page(rel.assets.map(assetJson), url) : new Response('{"message":"Not Found"}', { status: 404 })
  }
  if ((g = p.match(new RegExp(`^${R}/assets/(\\d+)$`)))) {
    const id = Number(g[1])
    const rel = releases.find((r) => r.assets.some((a) => a.id === id))
    if (!rel) return new Response('{"message":"Not Found"}', { status: 404 })
    if (m === 'DELETE') {
      rel.assets = rel.assets.filter((a) => a.id !== id)
      return new Response(null, { status: 204 })
    }
    if (m === 'GET' && req.headers.get('accept') === 'application/octet-stream')
      return new Response(null, { status: 302, headers: { location: `${base()}/download/${id}` } })
  }
  if (m === 'GET' && (g = p.match(/^\/download\/(\d+)$/))) {
    const id = Number(g[1])
    const a = releases.flatMap((r) => r.assets).find((x) => x.id === id)
    if (!a) return new Response('gone', { status: 404 })
    if (injected === 'truncate') return new Response(a.bytes.slice(0, a.bytes.length >> 1))
    if (injected === 'cut-stream') {
      // What the v0.21.9 run saw: the peer resets the stream part-way through.
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(a.bytes.slice(0, a.bytes.length >> 1))
            c.error(new Error('PROTOCOL_ERROR'))
          },
        }),
        { headers: { 'content-length': String(a.bytes.length) } },
      )
    }
    return new Response(a.bytes)
  }
  if (m === 'POST' && (g = p.match(new RegExp(`^/uploads${R}/(\\d+)/assets$`)))) {
    const rel = releases.find((r) => r.id === Number(g![1]))
    const name = url.searchParams.get('name') ?? ''
    if (!rel) return new Response('{"message":"Not Found"}', { status: 404 })
    if (rel.assets.some((a) => a.name === name))
      return Response.json({ message: 'Validation Failed', errors: [{ code: 'already_exists' }] }, { status: 422 })
    const bytes = new Uint8Array(await req.arrayBuffer())
    return Response.json(assetJson(addAsset(rel, name, bytes)), { status: 201 })
  }
  return new Response(`no route for ${m} ${p}`, { status: 404 })
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'release-assets-'))
  releases = []
  nextId = 1000
  log = []
  fault = () => undefined
  server = Bun.serve({ port: 0, fetch: route })
})

afterEach(() => {
  server.stop(true)
  rmSync(work, { recursive: true, force: true })
})

/** A local file in the work dir, standing in for a built installer. */
function file(name: string, content: string): string {
  const path = join(work, name)
  writeFileSync(path, content)
  return path
}

// Bun.spawn, not spawnSync: the server shares this event loop.
async function helper(script: string, env: Record<string, string> = {}) {
  return bash(`source "${HELPER}"\n${script}`, env)
}

async function bash(script: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bash', '-euo', 'pipefail', '-c', script], {
    cwd: work,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      GH_TOKEN: 'test-token',
      GITHUB_REPOSITORY: REPO,
      GITHUB_API_URL: base(),
      RELEASE_RETRY_ATTEMPTS: '3',
      RELEASE_RETRY_BACKOFF_SEC: '0',
      ...env,
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, output: stdout + stderr }
}

const intact = (rel: Release, name: string, content: string) => {
  const a = rel.assets.filter((x) => x.name === name)
  expect(a).toHaveLength(1)
  expect(a[0].state).toBe('uploaded')
  expect(new TextDecoder().decode(a[0].bytes)).toBe(content)
}

describe('ra_upload', () => {
  test('an upload 500 that leaves a starter stub is replaced, and only that file is sent again', async () => {
    const draft = addRelease({ tag_name: 'v1.0.0-desktop' })
    const deb = file('Hotline_1.0.0_amd64.deb', 'deb bytes '.repeat(500))
    const sig = file('Hotline_1.0.0_amd64.deb.sig', 'signature')
    let debUploads = 0
    fault = (m, _p, url) => {
      if (m === 'POST' && url.searchParams.get('name') === 'Hotline_1.0.0_amd64.deb' && ++debUploads === 1) {
        addAsset(draft, 'Hotline_1.0.0_amd64.deb', new Uint8Array(3), 'starter')
        return serverError()
      }
    }

    const { exitCode, output } = await helper(`ra_upload v1.0.0-desktop "${sig}" "${deb}"`)

    expect(output).toContain('::warning::Attaching 2 file(s) to the draft release v1.0.0-desktop failed (attempt 1/3')
    expect(output).toContain('HTTP 500')
    expect(output).toContain('replacing it')
    expect(output).toContain('Hotline_1.0.0_amd64.deb.sig: already attached')
    expect(exitCode).toBe(0)
    expect(debUploads).toBe(2)
    expect(count('POST /uploads')).toBe(3) // sig, deb, deb again — never sig twice
    expect(draft.assets).toHaveLength(2)
    intact(draft, 'Hotline_1.0.0_amd64.deb', readFileSync(deb, 'utf8'))
    intact(draft, 'Hotline_1.0.0_amd64.deb.sig', 'signature')
  })

  test('a re-run skips identical bytes and clobbers a same-named asset holding different bytes', async () => {
    const draft = addRelease({ tag_name: 'v1.0.0' })
    addAsset(draft, 'BUILD-MANIFEST.txt', new TextEncoder().encode('manifest'))
    addAsset(draft, 'CHECKSUMS.txt', new TextEncoder().encode('checksums from an earlier run'))

    const { exitCode, output } = await helper(
      `ra_upload v1.0.0 "${file('BUILD-MANIFEST.txt', 'manifest')}" "${file('CHECKSUMS.txt', 'checksums now')}"`,
    )

    expect(exitCode).toBe(0)
    expect(output).toContain('BUILD-MANIFEST.txt: already attached')
    expect(output).toContain('CHECKSUMS.txt: attached but not these bytes')
    expect(count('POST /uploads')).toBe(1)
    intact(draft, 'CHECKSUMS.txt', 'checksums now')
    intact(draft, 'BUILD-MANIFEST.txt', 'manifest')
  })

  test('an upload that never recovers fails loudly after the bounded attempts', async () => {
    addRelease({ tag_name: 'v1.0.0-android' })
    fault = (m, p) => (m === 'POST' && p.startsWith('/uploads') ? serverError() : undefined)

    const { exitCode, output } = await helper(`ra_upload v1.0.0-android "${file('app.apk', 'apk')}"`)

    expect(exitCode).not.toBe(0)
    expect(count('POST /uploads')).toBe(3)
    expect(output).toContain('::error::Attaching 1 file(s) to the draft release v1.0.0-android failed after 3 attempts')
  })

  test('a published (immutable) release is never uploaded to', async () => {
    addRelease({ tag_name: 'v1.0.0', draft: false })

    const { exitCode, output } = await helper(`ra_upload v1.0.0 "${file('x.txt', 'x')}"`)

    expect(exitCode).not.toBe(0)
    expect(output).toContain('expected exactly one draft release for v1.0.0, found 0')
    expect(count('POST /uploads')).toBe(0)
  })
})

describe('ra_download', () => {
  function draftWithAssets() {
    const rel = addRelease({ tag_name: 'v0.21.9' })
    addAsset(rel, 'llamenos-linux-x86_64.AppImage', new TextEncoder().encode('appimage '.repeat(2000)))
    addAsset(rel, 'BUILD-MANIFEST.txt', new TextEncoder().encode('manifest'))
    return rel
  }
  const downloaded = (name: string) => readFileSync(join(work, 'out', name), 'utf8')

  test('a stream reset mid-transfer (the v0.21.9 PROTOCOL_ERROR) is retried and the files verify', async () => {
    const rel = draftWithAssets()
    let n = 0
    fault = (m, p) => (m === 'GET' && p.startsWith('/download/') && ++n === 1 ? 'cut-stream' : undefined)

    const { exitCode, output } = await helper('ra_download v0.21.9 out')

    expect(output).toContain('::warning::Downloading every asset of the release v0.21.9 failed (attempt 1/3')
    expect(exitCode).toBe(0)
    expect(readdirSync(join(work, 'out')).sort()).toEqual(['BUILD-MANIFEST.txt', 'llamenos-linux-x86_64.AppImage'])
    for (const a of rel.assets) expect(downloaded(a.name)).toBe(new TextDecoder().decode(a.bytes))
  })

  test('a short body served with a 200 is caught by size, not accepted as the file', async () => {
    draftWithAssets()
    let n = 0
    fault = (m, p) => (m === 'GET' && p.startsWith('/download/') && ++n === 1 ? 'truncate' : undefined)

    const { exitCode, output } = await helper('ra_download v0.21.9 out')

    expect(output).toMatch(/downloaded \d+ bytes, GitHub says \d+/)
    expect(exitCode).toBe(0)
    expect(downloaded('llamenos-linux-x86_64.AppImage')).toBe('appimage '.repeat(2000))
  })

  test('same-length bytes that do not match GitHub’s digest are refused', async () => {
    const manifest = draftWithAssets().assets.find((a) => a.name === 'BUILD-MANIFEST.txt')!
    fault = (m, p) =>
      m === 'GET' && p === `/download/${manifest.id}` ? new Response('x'.repeat(manifest.bytes.length)) : undefined

    const { exitCode, output } = await helper('ra_download v0.21.9 out')

    expect(exitCode).not.toBe(0)
    expect(output).toContain("does not match GitHub's sha256:")
    expect(output).toContain('::error::Downloading every asset of the release v0.21.9 failed after 3 attempts')
    expect(existsSync(join(work, 'out', 'BUILD-MANIFEST.txt'))).toBe(false)
  })

  test('an asset whose upload never finished fails the download instead of being skipped', async () => {
    const rel = draftWithAssets()
    addAsset(rel, 'Hotline_0.21.9_amd64.deb', new Uint8Array(10), 'starter')

    const { exitCode, output } = await helper('ra_download v0.21.9 out')

    expect(exitCode).not.toBe(0)
    expect(output).toContain("Hotline_0.21.9_amd64.deb: state is 'starter'")
  })

  test('finds a draft on the second page of releases', async () => {
    draftWithAssets()
    for (let i = 0; i < 150; i++) addRelease({ tag_name: `v0.0.${i}`, draft: false })

    const { exitCode } = await helper('ra_download v0.21.9 out')

    expect(exitCode).toBe(0)
    expect(downloaded('BUILD-MANIFEST.txt')).toBe('manifest')
  })
})

describe('ra_create_draft', () => {
  test('a create that landed but whose response was lost converges on exactly one draft', async () => {
    let creates = 0
    fault = (m, p) => {
      if (m === 'POST' && p === `/repos/${REPO}/releases` && ++creates === 1) {
        addRelease({ tag_name: 'v2.0.0' })
        return serverError()
      }
    }
    writeFileSync(join(work, 'notes.md'), 'Release notes')

    const { exitCode, output } = await helper('ra_create_draft v2.0.0 "v2.0.0 API" notes.md abc123 false')

    expect(exitCode).toBe(0)
    expect(output).toContain('deleting the leftover draft v2.0.0')
    const drafts = releases.filter((r) => r.tag_name === 'v2.0.0')
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ draft: true, name: 'v2.0.0 API', body: 'Release notes', target_commitish: 'abc123' })
  })

  test('refuses, without retrying, when the tag is already published', async () => {
    addRelease({ tag_name: 'v2.0.0', draft: false })
    writeFileSync(join(work, 'notes.md'), 'n')

    const { exitCode, output } = await helper('ra_create_draft v2.0.0 t notes.md "" false')

    expect(exitCode).not.toBe(0)
    expect(output).toContain('::error::v2.0.0 is already published')
    expect(count(`POST /repos/${REPO}/releases`)).toBe(0)
  })
})

describe('ra_publish', () => {
  test('a publish that landed but whose response was lost is not repeated', async () => {
    const rel = addRelease({ tag_name: 'v3.0.0' })
    fault = (m) => {
      if (m === 'PATCH') {
        rel.draft = false
        return new Response('bad gateway', { status: 502 })
      }
    }

    const { exitCode, output } = await helper('ra_publish v3.0.0 true')

    expect(exitCode).toBe(0)
    expect(output).toContain('v3.0.0 is already published')
    expect(count('PATCH')).toBe(1)
  })

  test('publishes the draft and passes make_latest through', async () => {
    const rel = addRelease({ tag_name: 'v3.0.0-desktop' })

    const { exitCode } = await helper('ra_publish v3.0.0-desktop false')

    expect(exitCode).toBe(0)
    expect(rel).toMatchObject({ draft: false, make_latest: 'false' })
  })
})

describe('ra_published_url', () => {
  test('a transient list failure is retried', async () => {
    addRelease({ tag_name: 'v4.0.0-android', draft: false })
    let n = 0
    fault = (m, p) => (m === 'GET' && p === `/repos/${REPO}/releases` && ++n === 1 ? serverError() : undefined)

    const { exitCode, stdout } = await helper('ra_published_url v4.0.0-android')

    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe(`https://github.com/${REPO}/releases/tag/v4.0.0-android`)
  })

  test('a lookup that never succeeds fails — it never reads as "not published"', async () => {
    fault = () => serverError()

    const { exitCode, stdout } = await helper('url=$(ra_published_url v4.0.0) || exit 9; echo "url=[$url]"')

    expect(exitCode).toBe(9)
    expect(stdout).not.toContain('url=[')
  })
})

describe('ra_draft_asset_names', () => {
  test('lists the draft’s assets through a transient failure', async () => {
    const rel = addRelease({ tag_name: 'v5.0.0-ios' })
    addAsset(rel, 'Llamenos.ipa', new Uint8Array(4))
    addAsset(rel, 'Llamenos.ipa.sha256', new Uint8Array(2))
    let n = 0
    fault = (m, p) => (m === 'GET' && p.endsWith('/assets') && ++n === 1 ? serverError() : undefined)

    const { exitCode, stdout } = await helper('ra_draft_asset_names v5.0.0-ios')

    expect(exitCode).toBe(0)
    expect(stdout.trim().split('\n').sort()).toEqual(['Llamenos.ipa', 'Llamenos.ipa.sha256'])
  })
})

// release.yml's own step scripts, read out of the workflow and run as written,
// so the wiring cannot drift from what the release job executes.
describe('release.yml steps, run as written', () => {
  const step = (name: string) => {
    const doc = Bun.YAML.parse(readFileSync(join(import.meta.dir, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8')) as {
      jobs: Record<string, { steps?: { name?: string; run?: string }[] }>
    }
    const run = Object.values(doc.jobs)
      .flatMap((j) => j.steps ?? [])
      .find((s) => s.name === name)?.run
    if (!run) throw new Error(`release.yml has no step named ${name}`)
    return run
  }
  // The steps source the helper by its repo-relative path.
  const checkout = () => {
    mkdirSync(join(work, 'scripts', 'release'), { recursive: true })
    symlinkSync(HELPER, join(work, 'scripts', 'release', 'release-assets.sh'))
  }

  test('"Download everything attached to the draft" survives the v0.21.9 stream reset', async () => {
    checkout()
    const rel = addRelease({ tag_name: 'v0.21.9' })
    addAsset(rel, 'BUILD-MANIFEST.txt', new TextEncoder().encode('manifest'))
    let n = 0
    fault = (m, p) => (m === 'GET' && p.startsWith('/download/') && ++n === 1 ? 'cut-stream' : undefined)

    const { exitCode, output } = await bash(step('Download everything attached to the draft'), { NEW_VERSION: '0.21.9' })

    expect(output).toContain('::warning::Downloading every asset of the release v0.21.9 failed (attempt 1/3')
    expect(exitCode).toBe(0)
    expect(readFileSync(join(work, 'release-assets', 'BUILD-MANIFEST.txt'), 'utf8')).toBe('manifest')
  })

  test('"Attach checksums, SBOM, provenance and signatures to the draft" replaces a half-finished upload', async () => {
    checkout()
    const rel = addRelease({ tag_name: 'v0.21.9' })
    for (const f of ['CHECKSUMS.txt', 'provenance.json', 'sbom.cdx.json']) writeFileSync(join(work, f), `${f} bytes`)
    let n = 0
    fault = (m, _p, url) => {
      if (m === 'POST' && url.searchParams.get('name') === 'provenance.json' && ++n === 1) {
        addAsset(rel, 'provenance.json', new Uint8Array(1), 'starter')
        return serverError()
      }
    }

    const { exitCode } = await bash(step('Attach checksums, SBOM, provenance and signatures to the draft'), {
      NEW_VERSION: '0.21.9',
    })

    expect(exitCode).toBe(0)
    expect(rel.assets.map((a) => a.name).sort()).toEqual(['CHECKSUMS.txt', 'provenance.json', 'sbom.cdx.json'])
    intact(rel, 'provenance.json', 'provenance.json bytes')
  })

  test('"Publish release" is not repeated when its first response is lost, and marks it latest', async () => {
    checkout()
    const rel = addRelease({ tag_name: 'v0.21.9' })
    fault = (m) => {
      if (m === 'PATCH') {
        Object.assign(rel, { draft: false, make_latest: 'true' })
        return new Response('bad gateway', { status: 502 })
      }
    }

    const { exitCode } = await bash(step('Publish release'), { NEW_VERSION: '0.21.9' })

    expect(exitCode).toBe(0)
    expect(count('PATCH')).toBe(1)
    expect(rel).toMatchObject({ draft: false, make_latest: 'true' })
  })
})

// The helper only helps if the workflows use it. Every release create, upload,
// download, edit and lookup in the three release workflows goes through it.
describe('release workflows route every release-asset transfer through the helper', () => {
  const WORKFLOWS = ['release.yml', 'tauri-release.yml', 'mobile-release.yml']
  interface Step {
    name?: string
    run?: string
  }
  const steps = (wf: string) => {
    const doc = Bun.YAML.parse(readFileSync(join(import.meta.dir, '..', '..', '.github', 'workflows', wf), 'utf8')) as {
      jobs: Record<string, { steps?: Step[] }>
    }
    return Object.values(doc.jobs).flatMap((j) => j.steps ?? [])
  }
  const code = (run: string) =>
    run
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && !/^\s*echo /.test(l))
      .join('\n')

  for (const wf of WORKFLOWS) {
    test(`${wf}: no bare gh release / gh api releases calls`, () => {
      for (const s of steps(wf)) {
        if (!s.run) continue
        expect({ step: s.name, bare: code(s.run).match(/\bgh (release|api\b.*\breleases)\b.*/g) }).toEqual({
          step: s.name,
          bare: null,
        })
      }
    })

    test(`${wf}: every step calling ra_* sources the helper first`, () => {
      const users = steps(wf).filter((s) => s.run && /\bra_[a-z_]+\b/.test(code(s.run)))
      expect(users.length).toBeGreaterThan(0)
      for (const s of users) {
        const c = code(s.run!)
        const src = c.indexOf('source scripts/release/release-assets.sh')
        expect({ step: s.name, sourced: src >= 0 && src < c.search(/\bra_[a-z_]+ /) }).toEqual({
          step: s.name,
          sourced: true,
        })
      }
    })
  }
})
