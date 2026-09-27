import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Rail: no workflow may put a mixed-case repository path into a container
 * image reference.
 *
 * What went wrong. The repo moved to the `Llamenos-Hotline` org, so
 * `github.repository` now evaluates to `Llamenos-Hotline/llamenos-platform`
 * — the owner's *display* casing. OCI registries reject a mixed-case
 * repository path outright, and every workflow that pasted the raw value
 * into a tag broke at once:
 *
 *   ERROR: failed to build: invalid tag
 *   "ghcr.io/Llamenos-Hotline/llamenos-platform:buildcache":
 *   repository name must be lowercase
 *
 * Why a rail and not a code read. GitHub Actions has no lowercase function
 * in `${{ }}` expressions, and `with:` inputs are not shell — so `${VAR,,}`
 * written at a `with:` use site is inert text that *looks* like a fix. The
 * only place the fold can happen is a `run:` block that emits an
 * already-folded step output. That makes "is it folded?" a question about
 * shell behaviour, not about YAML text, so this rail **executes the real
 * run block** from each workflow with a mixed-case repository and reads the
 * `$GITHUB_OUTPUT` it produces. A grep for `,,` would pass on the inert
 * version; this does not.
 *
 * Each case carries a MUTATION that strips the fold from that same real run
 * block and shows the assertion catches it — proving the check is not
 * vacuously green just because today's owner happens to be lowercase.
 */

const WORKFLOWS = join(process.cwd(), '.github', 'workflows')

/** The owner casing that actually broke production. */
const MIXED_CASE_REPOSITORY = 'Llamenos-Hotline/llamenos-platform'
const EXPECTED_IMAGE = 'ghcr.io/llamenos-hotline/llamenos-platform'

interface WorkflowStep {
  name?: string
  id?: string
  run?: string
  uses?: string
  with?: Record<string, string>
  env?: Record<string, string>
}
interface WorkflowJob {
  env?: Record<string, string>
  steps: WorkflowStep[]
}
interface WorkflowDoc {
  env?: Record<string, string>
  jobs: Record<string, WorkflowJob>
}

function loadWorkflow(file: string): WorkflowDoc {
  return parseYaml(readFileSync(join(WORKFLOWS, file), 'utf8')) as WorkflowDoc
}

function job(doc: WorkflowDoc, name: string): WorkflowJob {
  const j = doc.jobs?.[name]
  if (!j) throw new Error(`no "${name}" job — the parser must not pass vacuously`)
  return j
}

function step(j: WorkflowJob, name: string): WorkflowStep {
  const s = j.steps.find((s) => s.name === name)
  if (!s) throw new Error(`no "${name}" step — the parser must not pass vacuously`)
  return s
}

/**
 * The runner-supplied values these meta steps read. `github.repository` is
 * deliberately the casing that broke production; the rest are inert
 * fixtures the fold does not depend on.
 */
const EXPRESSIONS: Readonly<Record<string, string>> = {
  'github.repository': MIXED_CASE_REPOSITORY,
  'needs.check.outputs.version': '1.2.3',
}

/**
 * Resolves the `${{ ... }}` expressions an env block may contain. An
 * expression with no fixture throws rather than quietly feeding the shell an
 * unexpanded literal — a silently-unsubstituted value would make the fold
 * assertion below meaningless.
 */
function resolveEnv(raw: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw ?? {})) {
    out[k] = String(v).replaceAll(/\$\{\{\s*([^}\s]+)\s*\}\}/g, (_m, path: string) => {
      const fixture = EXPRESSIONS[path]
      if (fixture === undefined) {
        throw new Error(`env "${k}" reads \${{ ${path} }}, which this rail has no fixture for`)
      }
      return fixture
    })
  }
  return out
}

/**
 * Runs a workflow `run:` block under bash — the shell GitHub uses for
 * `run:` on ubuntu-latest — with `$GITHUB_OUTPUT` pointed at a temp file,
 * and returns the step outputs it wrote.
 */
function runStep(script: string, env: Record<string, string>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'ghcr-ref-rail-'))
  const outputFile = join(dir, 'github_output')
  writeFileSync(outputFile, '')

  execFileSync('bash', ['-eo', 'pipefail', '-c', script], {
    env: { PATH: process.env['PATH'] ?? '', ...env, GITHUB_OUTPUT: outputFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Parse the `key=value` and `key<<EOF ... EOF` forms the real runner does.
  const outputs: Record<string, string> = {}
  const lines = readFileSync(outputFile, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const heredoc = line.match(/^([^=<]+)<<(.+)$/)
    if (heredoc) {
      const [, key, delimiter] = heredoc
      const body: string[] = []
      while (++i < lines.length && lines[i] !== delimiter) body.push(lines[i] ?? '')
      outputs[(key ?? '').trim()] = body.join('\n')
      continue
    }
    const eq = line.indexOf('=')
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return outputs
}

/** Strips bash's lowercase fold, reproducing the pre-fix defect exactly. */
function withoutTheFold(script: string): string {
  const mutated = script.replaceAll(',,}', '}')
  if (mutated === script) {
    throw new Error('mutation was a no-op — the step under test does not fold at all')
  }
  return mutated
}

/**
 * `image` must be a legal OCI repository path: the name component is
 * `[a-z0-9]+(?:[._-][a-z0-9]+)*` per path segment. A single uppercase letter
 * anywhere is what the registry rejects.
 */
function expectPublishableImageRef(image: string | undefined): void {
  expect(image, 'the meta step emitted no `image` output at all').toBeTruthy()
  expect(image).toBe(EXPECTED_IMAGE)
  expect(image).toMatch(/^[a-z0-9.\-_/:]+$/)
  expect(image).not.toMatch(/[A-Z]/)
}

/** The three workflows that interpolate `github.repository` into an image. */
const CASES: ReadonlyArray<{
  file: string
  job: string
  step: string
  /** Job- and workflow-level env the run block reads, beyond the step's own. */
  inheritedEnv: (doc: WorkflowDoc, j: WorkflowJob) => Record<string, string>
  /** Every `with:` value that must consume the folded output, never the raw name. */
  consumers: (j: WorkflowJob) => string[]
}> = [
  {
    file: 'release.yml',
    job: 'docker-stable',
    step: 'Compute stable tags',
    inheritedEnv: (_doc, j) => resolveEnv(j.env),
    consumers: (j) => {
      const push = step(j, 'Build and push stable image')
      const smoke = step(j, 'Build image for the pre-publish smoke')
      return [
        String(push.with?.['tags']),
        String(push.with?.['cache-from']),
        String(push.with?.['cache-to']),
        String(smoke.with?.['cache-from']),
      ]
    },
  },
  {
    file: 'docker-buildcache.yml',
    job: 'refresh',
    step: 'Compute cache image reference',
    inheritedEnv: (doc) => resolveEnv(doc.env),
    consumers: (j) => {
      const build = step(j, 'Build app image and export layer cache')
      return [
        String(build.with?.['tags']),
        String(build.with?.['cache-from']),
        String(build.with?.['cache-to']),
      ]
    },
  },
  {
    file: 'image-smoke.yml',
    job: 'smoke',
    step: 'Compute cache image reference',
    inheritedEnv: () => ({}),
    consumers: (j) => [String(step(j, 'Build app image').with?.['cache-from'])],
  },
]

describe.each(CASES)('rail: $file folds the repository path to lowercase before it reaches a registry', (c) => {
  function metaStep() {
    const doc = loadWorkflow(c.file)
    const j = job(doc, c.job)
    const s = step(j, c.step)
    if (!s.run) throw new Error(`"${c.step}" has no run block — the fold cannot happen in \`with:\``)
    return { doc, j, s, env: { ...c.inheritedEnv(doc, j), ...resolveEnv(s.env) } }
  }

  it('running the real step against a mixed-case owner emits a lowercase, publishable image ref', () => {
    const { s, env } = metaStep()
    const outputs = runStep(s.run!, env)
    expectPublishableImageRef(outputs['image'])

    // Every other output of these steps is also an image reference (the
    // `tags` list release.yml actually pushes), so none of them may carry
    // the raw casing either.
    for (const [key, value] of Object.entries(outputs)) {
      for (const line of value.split('\n').filter(Boolean)) {
        expect(line, `output "${key}" line "${line}" is not a lowercase image ref`).not.toMatch(/[A-Z]/)
        expect(line).toContain(EXPECTED_IMAGE)
      }
    }
  })

  it('MUTATION: the same step without its lowercase fold emits the ref the registry rejected', () => {
    const { s, env } = metaStep()
    const image = runStep(withoutTheFold(s.run!), env)['image']

    // The defect, reproduced: the raw display casing reaches the tag.
    expect(image).toBe('ghcr.io/Llamenos-Hotline/llamenos-platform')

    // ...and the assertion from the test above correctly rejects it.
    let caught: unknown
    try {
      expectPublishableImageRef(image)
    } catch (e) {
      caught = e
    }
    expect(caught, 'the lowercase assertion is vacuous — it accepted a mixed-case ref').toBeDefined()
  })

  it('every image-consuming `with:` input reads the folded step output, never the raw repository', () => {
    const { j } = metaStep()
    const consumers = c.consumers(j)
    expect(consumers.length, 'found no consumers — the parser must not pass vacuously').toBeGreaterThan(0)

    for (const value of consumers) {
      expect(value, 'a consuming `with:` input is missing entirely').toBeTruthy()
      // `with:` is not shell. A raw `github.repository` here cannot be
      // folded downstream, and a `${VAR,,}` written here would be inert
      // text — both are the bug this rail exists to stop.
      expect(value, `"${value}" interpolates github.repository directly`).not.toContain('github.repository')
      expect(value, `"${value}" uses bash syntax in a non-shell context`).not.toContain(',,}')
      // Any output of the meta step is acceptable — `image` and the `tags`
      // list release.yml derives from it are both folded at the source, and
      // the test above proves every emitted output is lowercase.
      expect(value).toContain('steps.meta.outputs.')
    }
  })
})

describe('rail: the buildcache consumer tracks the producer tag', () => {
  // `deploy/docker/docker-compose.test.yml` imports the cache
  // `docker-buildcache.yml` exports. Compose has no expression context, so
  // the ref there is a hand-written mirror — and a mismatch is *silent*
  // (cache import is a soft dependency; a miss just costs a full rebuild).
  // Nothing else would catch it, so it is checked here.
  it('docker-compose.test.yml cache_from matches the tag docker-buildcache.yml pushes', () => {
    const doc = loadWorkflow('docker-buildcache.yml')
    const j = job(doc, 'refresh')
    const s = step(j, 'Compute cache image reference')
    const produced = `${runStep(s.run!, resolveEnv(doc.env))['image']}:buildcache`

    const composeSrc = readFileSync(
      join(process.cwd(), 'deploy', 'docker', 'docker-compose.test.yml'),
      'utf8',
    )
    const match = composeSrc.match(/cache_from:\s*\n\s*-\s*type=registry,ref=(\S+)/)
    if (!match) throw new Error('no cache_from ref in docker-compose.test.yml — the parser must not pass vacuously')

    expect(match[1]).toBe(produced)
  })
})
