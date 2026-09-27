import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Rail for "every consumer of the desktop release-metadata repo names the same
 * repo" (#1226).
 *
 * The defect this replaces was not a typo, it was a disagreement. Five places
 * named `llamenos-releases` and they did not agree on the owner: the producer
 * (`tauri-release.yml`) pushed metadata to one address, the verifier
 * (`verify-build.sh`) fetched checksums from another, and the download page
 * advertised a third as its provenance trust anchor — and none of the three
 * existed, so all of them 404'd identically and nothing surfaced the split.
 *
 * That is the shape worth railing against. A single hardcoded expected string
 * would only restate the answer; what actually failed here is *agreement*, so
 * this rail derives the address from the PRODUCER — the `git clone` in
 * tauri-release.yml's metadata-commit step, which is the one place whose value
 * is load-bearing rather than descriptive, because it decides where the bytes
 * land — and requires every consumer to match it. Change the producer and the
 * consumers must follow; change one consumer and the rail fails.
 *
 * MUTATION PROOFS below show both halves are non-vacuous: that the producer is
 * really being parsed (not silently defaulting), and that a single divergent
 * consumer is really caught.
 *
 * Deliberately NOT in the consumer set:
 *
 *  - The RustFS S3 bucket, which is also called `llamenos-releases`
 *    (`scripts/release/*.sh`, `release-env.example`). Same name, different
 *    thing entirely: the bucket holds the binaries on our own infrastructure,
 *    the repo holds the metadata on GitHub. Only owner-qualified
 *    `<owner>/llamenos-releases` references are GitHub repo references, which
 *    is why OWNED_REF below requires the owner half.
 *
 *  - `docs/superpowers/plans/`, which are dated historical planning records.
 *    Rewriting what a past plan said is not a fix.
 */

const REPO_ROOT = process.cwd()

/** An owner-qualified reference to the metadata repo. The owner half is what
 *  makes it a GitHub repo rather than the identically-named S3 bucket. */
const OWNED_REF = /([A-Za-z0-9][-A-Za-z0-9]*)\/llamenos-releases/g

/** The step whose value decides where metadata is actually pushed. */
const PRODUCER = join('.github', 'workflows', 'tauri-release.yml')

/**
 * Every file that names the metadata repo and is expected to agree with the
 * producer. Kept explicit rather than globbed: a rail that discovers its own
 * inputs stops failing the moment a consumer is renamed out of the glob.
 */
const CONSUMERS = [
  join('.github', 'workflows', 'verify-release-live.yml'),
  join('.github', 'workflows', 'release.yml'),
  join('scripts', 'verify-build.sh'),
  join('docs', 'REPRODUCIBLE_BUILDS.md'),
  join('docs', 'deployment', 'first-deploy.md'),
  join('site', 'src', 'config.ts'),
]

/**
 * `site/src/config.ts` is migrated by #1220, which is open at the time of
 * writing and owns that file. Rather than hold a stale exemption, the rail
 * tolerates a consumer still on the PRE-MOVE owner and asserts that the set of
 * such laggards is exactly the one file that has an open PR for it. When #1220
 * lands, config.ts joins the agreement set with no edit here; if any OTHER file
 * regresses to the dead owner, the laggard-set assertion fails.
 */
const PRE_MOVE_OWNER = 'rhonda-rodododo'
const EXPECTED_LAGGARDS = [join('site', 'src', 'config.ts')]

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
}

/** All distinct owners a file names for `llamenos-releases`. */
function ownersIn(text: string): string[] {
  const owners: string[] = []
  for (const m of text.matchAll(OWNED_REF)) {
    const owner = m[1]
    if (owner) owners.push(owner)
  }
  return [...new Set(owners)]
}

/**
 * The owner the producer actually pushes metadata to: the `git clone` inside
 * the metadata-commit step, not just any mention in the file. Throws rather
 * than returning a default — a rail that cannot locate its own ground truth
 * must fail loudly, not pass on a fallback.
 */
function producerOwner(text: string): string {
  const clone = text
    .split('\n')
    .filter((l) => l.includes('git clone') && l.includes('llamenos-releases'))
  if (clone.length === 0) {
    throw new Error(
      `no \`git clone\` of llamenos-releases found in ${PRODUCER} — this rail cannot identify the ` +
        'metadata push target, so it must not pass vacuously. If the publish mechanism changed, update this rail.',
    )
  }
  const owners = [...new Set(clone.flatMap((l) => ownersIn(l)))]
  if (owners.length !== 1) {
    throw new Error(
      `${PRODUCER} clones llamenos-releases from more than one owner (${owners.join(', ')}) — ` +
        'the push-access probe and the metadata commit must target the same repo, or the probe proves nothing.',
    )
  }
  const only = owners[0]
  if (!only) throw new Error(`no owner parsed out of the llamenos-releases clone in ${PRODUCER}`)
  return only
}

describe('desktop release-metadata repo address (#1226)', () => {
  it('the producer names exactly one owner, in every place it clones the repo', () => {
    // tauri-release.yml clones twice: the push-access probe (which refuses to
    // upload binaries unless it can push) and the real metadata commit. If
    // those two disagree, the probe validates access to a repo the commit will
    // never touch — a green precondition for the wrong thing.
    const owner = producerOwner(read(PRODUCER))
    expect(owner).toBeTruthy()
    expect(owner).not.toBe(PRE_MOVE_OWNER)
  })

  it('every consumer names the same repo the producer pushes to', () => {
    const expected = producerOwner(read(PRODUCER))
    const laggards: string[] = []
    const disagreeing: Record<string, string[]> = {}

    for (const rel of CONSUMERS) {
      const owners = ownersIn(read(rel))
      expect(
        owners.length,
        `${rel} is listed as a consumer but names no <owner>/llamenos-releases reference — ` +
          'either the reference moved (update CONSUMERS) or this rail is checking a file it no longer covers',
      ).toBeGreaterThan(0)

      const wrong = owners.filter((o) => o !== expected)
      if (wrong.length === 0) continue
      if (wrong.every((o) => o === PRE_MOVE_OWNER)) laggards.push(rel)
      else disagreeing[rel] = wrong
    }

    expect(
      disagreeing,
      'these files name a llamenos-releases owner that is neither the producer\'s nor the ' +
        'known pre-move owner — the producer and its verifiers must agree, or a verifier ' +
        'checks a repo nothing was published to',
    ).toEqual({})

    expect(
      laggards.sort(),
      'the set of files still on the pre-move owner changed. Shrinking it is good — drop the ' +
        'file from EXPECTED_LAGGARDS. Growing it means a consumer regressed to a repo that ' +
        'does not exist (gh api repos/rhonda-rodododo/llamenos-releases -> 404).',
    ).toEqual([...EXPECTED_LAGGARDS].sort())
  })

  it('artifact publishing is not performed by CI', () => {
    // The operator's decision (#1226) has two halves, and this is the half a
    // rename sweep would not otherwise protect: metadata goes to the org repo
    // from CI, but BINARIES are published to our own infrastructure from a
    // local machine. CI produces release artifacts and never submits them.
    // The guard is narrow on purpose — it asserts the workflow gained no new
    // way to push binaries at our infra, without pretending to understand
    // every shell line in it.
    const producer = read(PRODUCER)
    const uploads = producer
      .split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(
        ([, l]) =>
          /\b(rsync|scp)\b/.test(l) ||
          (/\bcurl\b/.test(l) && /\b(-T|--upload-file)\b/.test(l)) ||
          (/\bssh\b/.test(l) && !/ssh-/.test(l)),
      )
    expect(
      uploads.map(([n, l]) => `${n}: ${l.trim()}`),
      'tauri-release.yml gained a step that pushes bytes to our own infrastructure. Artifact ' +
        'publishing is a local operator action (see the offline signing workflow in ' +
        '.claude/skills/release-signing/SKILL.md); CI publishes METADATA to the GitHub metadata ' +
        'repo and nothing else.',
    ).toEqual([])
  })

  describe('MUTATION — these prove the assertions above are not vacuous', () => {
    it('a consumer that names a different owner is caught', () => {
      const expected = producerOwner(read(PRODUCER))
      const mutated = read(join('scripts', 'verify-build.sh')).replace(
        `${expected}/llamenos-releases`,
        'some-other-org/llamenos-releases',
      )
      const owners = ownersIn(mutated)
      expect(owners).toContain('some-other-org')
      expect(owners.filter((o) => o !== expected && o !== PRE_MOVE_OWNER)).not.toEqual([])
    })

    it('a producer whose two clones disagree is caught', () => {
      const mutated = read(PRODUCER).replace(
        'https://x-access-token:${GH_TOKEN}@github.com/Llamenos-Hotline/llamenos-releases.git" "$PROBE_DIR"',
        'https://x-access-token:${GH_TOKEN}@github.com/some-other-org/llamenos-releases.git" "$PROBE_DIR"',
      )
      expect(mutated, 'the mutation did not apply — the probe clone line changed shape').not.toBe(read(PRODUCER))
      expect(() => producerOwner(mutated)).toThrow(/more than one owner/)
    })

    it('a producer with no clone at all fails loudly rather than passing', () => {
      expect(() => producerOwner('jobs:\n  release:\n    steps: []\n')).toThrow(/cannot identify the metadata push target/)
    })

    it('an added binary upload step is caught', () => {
      const mutated = read(PRODUCER) + '\n          rsync -a artifacts/ deploy@releases.example:/srv/desktop/\n'
      const uploads = mutated.split('\n').filter((l) => /\b(rsync|scp)\b/.test(l))
      expect(uploads).not.toEqual([])
    })
  })
})
