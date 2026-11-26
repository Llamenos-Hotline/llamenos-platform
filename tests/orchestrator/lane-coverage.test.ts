import { describe, it, expect, beforeAll } from 'vitest'
import { loadLanes, loadGrantableLanes, GRANT_EXCLUDED_PATHS, NEVER_WRITE_PATHS, type Lane } from '../../orchestrator/src/config.js'
import { loadLaneScopes, matchesPath, type LaneScope } from '../../orchestrator/src/fragments.js'
import { checkScope, checkScopeRouting } from '../../orchestrator/src/scope.js'
import { reviewLanesFor } from '../../orchestrator/src/route.js'
import { trackedFiles } from './codeowners.js'

/**
 * #2935 — the fourth occurrence of the #1115 unowned-path class, and the one
 * the ruling on that issue closes for good: **"owned by no lane" is not a
 * reachable verdict.** (#2875 was the third: `orchestrator/` in #1836,
 * `/README.md` + `docs/QUICKSTART.md`, `.github/scripts/`.)
 *
 * A path that no lane owns is not merely unreviewed. `fleet/verify` reports it
 * as out of scope, no `scope:` grant can reach it, so NO PR can change it, and
 * the gate's advised remedy (move the file somewhere owned) reads as writing
 * the unowned original. #2957 hit it live on
 * `docs/runbooks/provider-webhook-rejections.md`: its backend half was
 * grantable, its runbook was not, and that one file made it unmergeable.
 *
 * WHAT WAS WRONG WITH THE RATCHET THAT SHIPPED WITH #2894. It was green while
 * the hole was open, for two independent reasons, both fixed here:
 *
 * 1. It exempted the hole. A `KNOWN_UNOWNED` list named 654 tracked files —
 *    `docs/` whole, `.claude/`, the root configs, `public/`, `flatpak/` — as
 *    "the backlog this ratchets down". A test that excludes the failing paths
 *    asserts nothing about them. The list is gone: every tracked path is owned
 *    or is in `WITHHELD_BY_DESIGN` below, which says why and is itself checked.
 *
 * 2. It measured fragments, not the gate. "Owned" meant "some fragment's
 *    `checkScope` accepts it", but the gate's candidates for a grant are
 *    `loadGrantableLanes`, in which the scope-only `mac` fragment is NARROWED
 *    to `SCOPE_ONLY_GRANT_PATHS`. `scripts/mac-run.sh`,
 *    `scripts/ci/mac-runner-disk-guard.sh` and `tests/runner-boundary.spec.ts`
 *    are owned by the mac fragment, so the ratchet counted them owned, while
 *    the gate answered `unowned` for every one of them. The ratchet now asks
 *    the gate's own instruments (then `planScopeGrants` and `scopeStrayAdvice`,
 *    now `checkScopeRouting` and `reviewLanesFor`) with the gate's own lane
 *    list, for every file, as every lane's PR.
 *
 * #3056 changed what the gate does with an unowned or cross-lane path: it no
 * longer REFUSES one (stray-scope is routing, `checkScopeRouting`/`reviewLanesFor`),
 * so "owned by no lane" stopped being a verdict and became a hole in review
 * routing — a path no lane owns names no reviewer. The ownership assertions
 * below are therefore still the rail that matters; what they judge the gate by
 * is what it still does: refuse the supply chain, and route the rest.
 *
 * It runs against the REAL fragments and the REAL tree, because the failure is
 * a disagreement between what the tree contains and what the fragments
 * declare, which a hand-written lane table cannot reproduce.
 */

/**
 * Paths that NO lane owns, on purpose, each with the reason a reviewer can
 * disagree with. Adding one is a deliberate act. The entry must stay unowned
 * (a dead entry fails below) and must be in `GRANT_EXCLUDED_PATHS`, so the gate
 * REFUSES it on every lane's PR rather than merely routing it to nobody.
 */
const WITHHELD_BY_DESIGN: ReadonlyArray<{ path: string; why: string }> = [
  {
    path: '.claude/agents/fragments/',
    why:
      'the fragments declare every lane\'s own scope. A lane that can edit the file judging it can widen its own authority inside a ' +
      'branch, before any reviewer sees the diff. Withheld rather than assigned to infra: infra\'s OWN PR is not subject to the grant ' +
      'exclusion, so ownership would have made the declaring files writable by the lane they declare. Written only on a non-fleet branch.',
  },
]

let scopes: Record<string, LaneScope>
let tracked: string[]
let lanes: Lane[]
let grantable: Lane[]
beforeAll(async () => {
  scopes = await loadLaneScopes(process.cwd())
  tracked = trackedFiles()
  lanes = await loadLanes(process.cwd())
  grantable = await loadGrantableLanes(process.cwd())
})

const fragmentOwns = (file: string): boolean =>
  Object.values(scopes).some((s) => s.owned.length > 0 && checkScope([file], s, []).strayed.length === 0)

const withheld = (file: string): boolean => WITHHELD_BY_DESIGN.some((w) => file.startsWith(w.path))

const route = (files: string[], own: Lane) => checkScopeRouting(files, own.scope, NEVER_WRITE_PATHS, GRANT_EXCLUDED_PATHS)

describe('no path is owned by nobody (#2935, #2875, #1115)', () => {
  it('every tracked file is owned by a fragment, or is withheld by design', () => {
    const orphans = tracked.filter((f) => !fragmentOwns(f) && !withheld(f))
    // Printed whole: the remedy is to assign the path in a fragment, and the
    // reviewer needs to see which without re-running the scan.
    expect(orphans, `owned by no fragment and not in WITHHELD_BY_DESIGN:\n  ${orphans.join('\n  ')}`).toEqual([])
  })

  it('a path no lane owns is routed to nobody and refused to nobody — except the supply chain (#3056)', () => {
    const infra = lanes.find((l) => l.id === 'infra')
    if (infra === undefined) throw new Error('no infra lane')
    const ghost = 'zzz-owned-by-nobody/file.txt'
    expect(fragmentOwns(ghost)).toBe(false)
    const r = route([ghost], infra)
    expect(r).toEqual({ forbidden: [], supplyChain: [], outside: [ghost] })
    expect(reviewLanesFor(r.outside, infra.id, grantable)).toEqual([])
  })

  it('the instrument can fail: take docs/ ownership away and the runbook that blocked #2957 stops naming a reviewer (audit by breaking)', () => {
    const ios = lanes.find((l) => l.id === 'ios')
    if (ios === undefined) throw new Error('no ios lane')
    const runbook = 'docs/runbooks/deploy-official.md'
    expect(reviewLanesFor([runbook], ios.id, grantable)).toEqual([{ lane: 'infra', files: [runbook] }])
    const withoutDocs = grantable.map((l) => ({ ...l, scope: { ...l.scope, owned: l.scope.owned.filter((p) => !p.startsWith('docs/')) } }))
    expect(reviewLanesFor([runbook], ios.id, withoutDocs)).toEqual([])
  })

  it('every tracked file has an AUTHORING owner — a lane that can hold a branch — or is withheld by design (#2723)', () => {
    // A fragment that is not a lane (mac) can review a path and be granted onto
    // one, but can never author it: `fleet/mac/<n>` is "unknown lane". A path
    // only such a fragment owns is writable by no fleet branch at all — the
    // shape of .github/workflows/ios-e2e.yml before #2723.
    const authorOwns = (f: string): boolean => lanes.some((l) => l.scope.owned.length > 0 && checkScope([f], l.scope, []).strayed.length === 0)
    const orphans = tracked.filter((f) => !authorOwns(f) && !withheld(f))
    expect(orphans, `owned by no authoring lane and not in WITHHELD_BY_DESIGN:\n  ${orphans.join('\n  ')}`).toEqual([])
  })

  it('the Mac host files are authored by infra and REFUSED to every other lane (#2723) — mac reviews them', () => {
    const infra = lanes.find((l) => l.id === 'infra')
    if (infra === undefined) throw new Error('no infra lane')
    for (const f of ['scripts/ci/mac-runner-disk-guard.sh', 'scripts/mac-run.sh', 'tests/runner-boundary.spec.ts', '.github/workflows/ios-e2e.yml']) {
      expect(tracked, f).toContain(f)
      expect(checkScope([f], infra.scope, []).strayed, `infra authors ${f}`).toEqual([])
      expect(GRANT_EXCLUDED_PATHS.some((p) => matchesPath(f, p)), `${f} must be grant-excluded`).toBe(true)
      for (const own of lanes.filter((l) => l.id !== 'infra')) {
        expect(route([f], own).supplyChain, `${f} on a ${own.id} PR`).toEqual([f])
      }
    }
  })

  it('every WITHHELD_BY_DESIGN entry is still unowned, still tracked, and grant-excluded — a dead one must go', () => {
    for (const w of WITHHELD_BY_DESIGN) {
      const files = tracked.filter((f) => f.startsWith(w.path))
      expect(files.length, `${w.path} covers no tracked file — delete the entry`).toBeGreaterThan(0)
      expect(files.filter(fragmentOwns), `${w.path} is now owned by a fragment — delete the entry or the ownership`).toEqual([])
      for (const f of files) expect(GRANT_EXCLUDED_PATHS.some((p) => matchesPath(f, p)), `${f} must be grant-excluded`).toBe(true)
    }
  })

  it('the scan is not vacuous: fragments own real paths and nearly the whole tree', () => {
    expect(Object.values(scopes).filter((s) => s.owned.length > 0).length).toBeGreaterThanOrEqual(7)
    expect(tracked.length).toBeGreaterThan(1000)
    expect(tracked.filter(fragmentOwns).length).toBeGreaterThan(tracked.length - 20)
  })
})

describe('the scope-declaring fragments are refused to every lane (#2935, #3056)', () => {
  const fragments = (): string[] => tracked.filter((f) => f.startsWith('.claude/agents/fragments/'))

  it('the fragments are tracked (so the assertions below are about real files)', () => {
    expect(fragments()).toContain('.claude/agents/fragments/infra-supervisor.md')
    expect(fragments()).toContain('.claude/agents/fragments/_worker-rules.md')
  })

  it('no lane — and no scope-only fragment — owns one', () => {
    for (const f of fragments()) {
      for (const l of grantable) expect(checkScope([f], l.scope, []).strayed, `${l.id} must not own ${f}`).toEqual([f])
    }
  })

  // Nobody owns them, so for every lane's PR they are outside the lane AND
  // supply chain: refused, and there is no label that could change that.
  it('whichever lane the PR is on, the gate refuses one', () => {
    for (const f of fragments()) {
      for (const own of lanes) {
        expect(route([f], own), `${f} on a ${own.id} PR`).toEqual({ forbidden: [], supplyChain: [f], outside: [f] })
      }
    }
  })

  it('the rest of .claude/ is owned (so a PR can change it) but equally refused to every other lane', () => {
    const settings = '.claude/settings.json'
    expect(tracked).toContain(settings)
    const infra = lanes.find((l) => l.id === 'infra')
    const backend = lanes.find((l) => l.id === 'backend')
    if (infra === undefined || backend === undefined) throw new Error('missing lane')
    expect(checkScope([settings], infra.scope, []).strayed).toEqual([])
    expect(route([settings], backend).supplyChain).toEqual([settings])
    expect(route([settings], infra).supplyChain).toEqual([])
  })
})

describe('the files that decide what scanners and reviewers see are owned by infra and refused to everyone else (#2935, #3056)', () => {
  const GATE_CONFIG = [
    '.gitleaks.toml', '.gitleaksignore', '.trivyignore', '.codeqlignore', 'deny.toml', '.mise.toml', '.mcp.json', 'CODEOWNERS',
    '.github/labels.yml', '.github/dependabot.yml', '.github/actionlint.yaml', '.github/codeql/codeql-config.yml',
    '.github/ci/audit-allowlist.txt', '.claude/settings.json',
    // Alternate spellings and locations of the same files: a new file there would replace or shadow the one in force.
    '.github/CODEOWNERS', 'docs/CODEOWNERS', '.github/dependabot.yaml', '.github/actionlint.yml', '.github/labels.yaml',
  ]
  // Not tracked today, so they are asserted against the gate directly rather than through the tree.
  const NOT_YET_TRACKED = new Set(['.github/CODEOWNERS', 'docs/CODEOWNERS', '.github/dependabot.yaml', '.github/actionlint.yml', '.github/labels.yaml'])
  const GRANTABLE_ROOT = ['.gitignore', '.dockerignore', 'CONTRIBUTING.md', 'LICENSE', '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug_report.yml']
  const lane = (id: string): Lane => {
    const l = lanes.find((x) => x.id === id)
    if (l === undefined) throw new Error(`no lane ${id}`)
    return l
  }

  it('infra owns all of them, so its own PR can change them', () => {
    for (const f of [...GATE_CONFIG, ...GRANTABLE_ROOT]) {
      if (!NOT_YET_TRACKED.has(f)) expect(tracked, f).toContain(f)
      expect(checkScope([f], lane('infra').scope, []).strayed, f).toEqual([])
    }
  })

  it('no other lane\'s PR may write the gate configuration — there is no label to carry it there', () => {
    for (const own of lanes.filter((l) => l.id !== 'infra')) {
      for (const f of GATE_CONFIG) {
        expect(route([f], own).supplyChain, `${f} on a ${own.id} PR`).toEqual([f])
      }
    }
  })

  it('the relaxed half: ordinary root files are only routed to infra, never refused', () => {
    const backend = lane('backend')
    for (const f of GRANTABLE_ROOT) {
      expect(route([f], backend), f).toEqual({ forbidden: [], supplyChain: [], outside: [f] })
      expect(reviewLanesFor([f], backend.id, grantable), f).toEqual([{ lane: 'infra', files: [f] }])
    }
  })

  it('root-anchored: infra owns the root .gitignore, not every nested one other lanes own', () => {
    const nested = tracked.filter((f) => /^(apps|packages|src)\//.test(f) && f.endsWith('.gitignore'))
    expect(nested.length).toBeGreaterThan(0)
    expect(nested.filter((f) => checkScope([f], lane('infra').scope, []).strayed.length === 0)).toEqual([])
  })
})

describe('documentation lands with what it documents (#2935)', () => {
  const RUNBOOK = 'docs/runbooks/provider-webhook-rejections.md'
  const MAC_RUNBOOK = 'docs/runbooks/mac-ci-runner-disk.md'
  // The #2957 diff: the backend half and the runbook that explains it.
  const PR_2957 = [
    'apps/worker/lib/config.ts',
    'apps/worker/__tests__/integration/startup-init.test.ts',
    'apps/worker/__tests__/unit/webhook-ip-allowlist-posture.test.ts',
    RUNBOOK,
  ]
  const lane = (id: string): Lane => {
    const l = grantable.find((x) => x.id === id)
    if (l === undefined) throw new Error(`no lane ${id}`)
    return l
  }
  const outside = (files: string[], own: Lane): string[] => route(files, own).outside
  const reviewers = (files: string[], own: Lane): string[] => reviewLanesFor(outside(files, own), own.id, grantable).map((r) => r.lane)

  it('the runbook is reachable by a PR that also touches apps/worker/lib/config.ts — as one commit, from either lane', () => {
    expect(tracked).toContain(RUNBOOK)
    // A backend PR owns the whole diff outright: nothing outside, nobody to ask.
    expect(outside(PR_2957, lane('backend'))).toEqual([])
    // #2957 as it was actually opened — an infra PR. It is no longer refused:
    // the backend half is routed to backend, which reviews it.
    expect(route(PR_2957, lane('infra'))).toEqual({
      forbidden: [], supplyChain: [], outside: PR_2957.filter((f) => f.startsWith('apps/worker/')),
    })
    expect(reviewers(PR_2957, lane('infra'))).toEqual(['backend'])
  })

  it('the routing is not a blanket: each file names the lane that owns it, and only that lane', () => {
    expect(reviewers(['apps/worker/lib/config.ts'], lane('desktop'))).toEqual(['backend'])
    expect(reviewers(['src/client/routes/x.tsx'], lane('infra'))).toEqual(['desktop'])
    // …and a docs-owning lane owns docs, not the code those docs describe.
    expect(outside(['apps/worker/lib/config.ts', 'docs/runbooks/rollback.md'], lane('infra'))).toEqual(['apps/worker/lib/config.ts'])
  })

  it('infra authors the mac runbook through docs/ (#2723); mac reviews exactly that one file', () => {
    expect(checkScope([MAC_RUNBOOK], lane('infra').scope, []).strayed).toEqual([])
    for (const l of lanes) {
      if (l.id === 'infra') continue
      expect(checkScope([MAC_RUNBOOK], l.scope, []).strayed, `${l.id} must not own the mac runbook`).toEqual([MAC_RUNBOOK])
    }
    // An infra PR owns it outright; on another lane's PR it names mac, and mac names nothing else.
    expect(outside([MAC_RUNBOOK, 'docs/runbooks/deploy-official.md'], lane('infra'))).toEqual([])
    expect(reviewers([MAC_RUNBOOK], lane('ios'))).toEqual(['mac'])
    expect(reviewers(['docs/runbooks/deploy-official.md'], lane('ios'))).toEqual(['infra'])
  })

  it('the docs tree is owned by infra and by the surface it documents, and nothing is left over', () => {
    const docs = tracked.filter((f) => f.startsWith('docs/'))
    expect(docs.length).toBeGreaterThan(300)
    // Infra owns every doc except the three carve-outs, each of which has its own owner.
    const CARVED_OUT = (f: string): boolean =>
      f.startsWith('docs/security/') || f.startsWith('docs/protocol/') || f === 'docs/architecture/E2EE_ARCHITECTURE.md'
    expect(docs.filter((f) => !CARVED_OUT(f) && checkScope([f], lane('infra').scope, []).strayed.length > 0)).toEqual([])
    expect(docs.filter((f) => CARVED_OUT(f) && checkScope([f], lane('infra').scope, []).strayed.length === 0)).toEqual([])
    // …and the carve-outs are exclusive to the lane that owned them before the ruling.
    expect(docs.filter((f) => f.startsWith('docs/security/') || f.startsWith('docs/protocol/') || f === 'docs/architecture/E2EE_ARCHITECTURE.md')
      .filter((f) => checkScope([f], lane('shared').scope, []).strayed.length > 0)).toEqual([])
    for (const id of ['backend', 'desktop', 'ios', 'android', 'infra']) {
      expect(checkScope(['docs/security/CRYPTO_ARCHITECTURE.md', 'docs/protocol/PROTOCOL.md'], lane(id).scope, []).strayed, id).toHaveLength(2)
    }
    expect(checkScope([RUNBOOK], lane('backend').scope, []).strayed).toEqual([])
    expect(checkScope(['docs/runbooks/android-release.md'], lane('android').scope, []).strayed).toEqual([])
    // A surface lane owns ITS docs, not the whole tree.
    expect(checkScope(['docs/runbooks/rollback.md'], lane('backend').scope, []).strayed).toEqual(['docs/runbooks/rollback.md'])
  })
})

describe('.github/scripts/ — assigned to infra and refused to every other lane (#2875 option 1, #3056)', () => {
  const SCRIPTS = [
    '.github/scripts/check-action-pins.test.ts',
    '.github/scripts/check-action-pins.ts',
    '.github/scripts/check-local-paths.py',
    '.github/scripts/classify-infra-failure.py',
    '.github/scripts/detect-changed-platforms.sh',
    '.github/scripts/gh-read.sh',
    '.github/scripts/is-release-bump.sh',
    '.github/scripts/test_check_local_paths.py',
  ]

  it('the scripts are tracked (so the assertions below are about real files)', () => {
    for (const f of SCRIPTS) expect(tracked, f).toContain(f)
  })

  it('infra owns every one of them outright, and no other lane does', () => {
    const infra = lanes.find((l) => l.id === 'infra')
    if (infra === undefined) throw new Error('no infra lane')
    for (const f of SCRIPTS) {
      expect(checkScope([f], infra.scope, []).strayed, `${f} outside infra`).toEqual([])
      for (const other of lanes.filter((l) => l.id !== 'infra')) {
        expect(checkScope([f], other.scope, []).strayed, `${f} must not be ${other.id}'s`).toEqual([f])
      }
    }
  })

  it('another lane\'s PR may not write them — the same treatment as .github/workflows/', () => {
    expect(GRANT_EXCLUDED_PATHS).toContain('.github/scripts/')
    const backend = lanes.find((l) => l.id === 'backend')
    if (backend === undefined) throw new Error('no backend lane')
    for (const f of SCRIPTS) expect(route([f], backend).supplyChain, f).toEqual([f])
  })

  it('no compiled Python artifact is tracked under it', () => {
    expect(tracked.filter((f) => f.includes('__pycache__/') || f.endsWith('.pyc'))).toEqual([])
  })
})
