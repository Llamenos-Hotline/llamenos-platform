import { describe, it, expect, beforeAll } from 'vitest'
import { loadLanes, loadGrantableLanes, GRANT_EXCLUDED_PATHS, NEVER_WRITE_PATHS, type Lane } from '../../orchestrator/src/config.js'
import { loadLaneScopes, matchesPath, type LaneScope } from '../../orchestrator/src/fragments.js'
import { checkScope, checkScopeAcross } from '../../orchestrator/src/scope.js'
import { planScopeGrants } from '../../orchestrator/src/scope-grant.js'
import { scopeStrayAdvice } from '../../orchestrator/src/verify.js'
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
 *    the gate's own two instruments (`planScopeGrants`, `scopeStrayAdvice`)
 *    with the gate's own lane list, for every file, as every lane's PR.
 *
 * It runs against the REAL fragments and the REAL tree, because the failure is
 * a disagreement between what the tree contains and what the fragments
 * declare, which a hand-written lane table cannot reproduce.
 */

/**
 * Paths that NO lane owns, on purpose, each with the reason a reviewer can
 * disagree with. Adding one is a deliberate act. The entry must stay unowned
 * (a dead entry fails below) and must be grant-excluded, so the gate's verdict
 * for it is "grant-excluded" — true, with an accurate remedy — and never
 * "owned by no lane".
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

/**
 * Every way the live gate can answer "owned by no lane" for `file`, when a PR
 * on lane `own` touches it: the grant planner's `unowned` refusal and the
 * `scope advice:` line `fleet/verify` prints. Empty means the gate never says it.
 */
function unownedVerdicts(file: string, own: Lane, all: Lane[]): string[] {
  const out: string[] = []
  const plan = planScopeGrants([file], own, all)
  if (plan.refused.some((r) => r.reason === 'unowned')) out.push(`planScopeGrants: ${file} unowned on a ${own.id} PR`)
  // scopeStrayAdvice is only ever handed files the PR's own lane strays on.
  if (checkScope([file], own.scope, []).strayed.length > 0) {
    if (scopeStrayAdvice([file], own, all).some((l) => l.includes('owned by no lane'))) {
      out.push(`scopeStrayAdvice: ${file} "owned by no lane" on a ${own.id} PR`)
    }
  }
  return out
}

describe('no path is owned by nobody (#2935, #2875, #1115)', () => {
  it('every tracked file is owned by a fragment, or is withheld by design', () => {
    const orphans = tracked.filter((f) => !fragmentOwns(f) && !withheld(f))
    // Printed whole: the remedy is to assign the path in a fragment, and the
    // reviewer needs to see which without re-running the scan.
    expect(orphans, `owned by no fragment and not in WITHHELD_BY_DESIGN:\n  ${orphans.join('\n  ')}`).toEqual([])
  })

  it('the live gate never answers "owned by no lane" — for any tracked file, as any lane\'s PR', () => {
    const verdicts = tracked.flatMap((f) => lanes.flatMap((own) => unownedVerdicts(f, own, grantable)))
    expect(verdicts, `the gate still reports an unowned path:\n  ${verdicts.slice(0, 40).join('\n  ')}`).toEqual([])
  })

  it('the instrument can fail: a path nobody owns IS reported (audit by breaking)', () => {
    const infra = lanes.find((l) => l.id === 'infra')
    if (infra === undefined) throw new Error('no infra lane')
    const ghost = 'zzz-owned-by-nobody/file.txt'
    expect(fragmentOwns(ghost)).toBe(false)
    expect(unownedVerdicts(ghost, infra, grantable).length).toBe(2)
    // …and with the fragments' docs ownership removed, the runbook that blocked #2957 is reported again.
    const withoutDocs = lanes.map((l) => ({ ...l, scope: { ...l.scope, owned: l.scope.owned.filter((p) => !p.startsWith('docs/')) } }))
    const infraNoDocs = withoutDocs.find((l) => l.id === 'infra')
    if (infraNoDocs === undefined) throw new Error('no infra lane')
    expect(unownedVerdicts('docs/runbooks/deploy-official.md', infraNoDocs, withoutDocs).length).toBeGreaterThan(0)
  })

  it('the old ratchet was blind to these: owned by the mac fragment, narrowed out of the grantable lane, so grant-excluded', () => {
    const infra = lanes.find((l) => l.id === 'infra')
    if (infra === undefined) throw new Error('no infra lane')
    for (const f of ['scripts/ci/mac-runner-disk-guard.sh', 'scripts/mac-run.sh', 'tests/runner-boundary.spec.ts']) {
      expect(tracked, f).toContain(f)
      expect(fragmentOwns(f), `${f} is owned by the mac fragment`).toBe(true)
      expect(GRANT_EXCLUDED_PATHS.some((p) => matchesPath(f, p)), `${f} must be grant-excluded`).toBe(true)
      expect(planScopeGrants([f], infra, grantable).refused).toEqual([{ file: f, reason: 'grant-excluded' }])
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

describe('the scope-declaring fragments are unreachable by any scope grant (#2935)', () => {
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

  it('a grant cannot carry any lane onto one, whichever lane the PR is on', () => {
    for (const f of fragments()) {
      for (const own of lanes) {
        expect(planScopeGrants([f], own, grantable).refused, `${f} on a ${own.id} PR`).toEqual([{ file: f, reason: 'grant-excluded' }])
        // The gate's own judgement with EVERY other lane granted at once, which is the widest a label set can be.
        const others = grantable.filter((l) => l.id !== own.id).map((l) => l.scope)
        expect(checkScopeAcross([f], own.scope, others, NEVER_WRITE_PATHS, GRANT_EXCLUDED_PATHS).strayed, `${f} on a ${own.id} PR`).toEqual([f])
      }
    }
  })

  it('the rest of .claude/ is owned (so a PR can change it) but equally ungrantable', () => {
    const settings = '.claude/settings.json'
    expect(tracked).toContain(settings)
    const infra = lanes.find((l) => l.id === 'infra')
    const backend = lanes.find((l) => l.id === 'backend')
    if (infra === undefined || backend === undefined) throw new Error('missing lane')
    expect(checkScope([settings], infra.scope, []).strayed).toEqual([])
    expect(checkScopeAcross([settings], backend.scope, [infra.scope], NEVER_WRITE_PATHS, GRANT_EXCLUDED_PATHS).strayed).toEqual([settings])
  })
})

describe('the files that decide what scanners and reviewers see are owned but ungrantable (#2935)', () => {
  const GATE_CONFIG = [
    '.gitleaks.toml', '.gitleaksignore', '.trivyignore', '.codeqlignore', 'deny.toml', '.mise.toml', '.mcp.json', 'CODEOWNERS',
    '.github/labels.yml', '.github/dependabot.yml', '.github/actionlint.yaml', '.github/codeql/codeql-config.yml',
    '.github/ci/audit-allowlist.txt', '.claude/settings.json',
  ]
  const GRANTABLE_ROOT = ['.gitignore', '.dockerignore', 'CONTRIBUTING.md', 'LICENSE', '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug_report.yml']
  const lane = (id: string): Lane => {
    const l = lanes.find((x) => x.id === id)
    if (l === undefined) throw new Error(`no lane ${id}`)
    return l
  }

  it('infra owns all of them, so its own PR can change them', () => {
    for (const f of [...GATE_CONFIG, ...GRANTABLE_ROOT]) {
      expect(tracked, f).toContain(f)
      expect(checkScope([f], lane('infra').scope, []).strayed, f).toEqual([])
    }
  })

  it('no scope: grant can carry another lane onto the gate configuration — with EVERY lane granted at once', () => {
    for (const own of lanes.filter((l) => l.id !== 'infra')) {
      const granted = lanes.filter((l) => l.id !== own.id).map((l) => l.scope)
      for (const f of GATE_CONFIG) {
        expect(checkScopeAcross([f], own.scope, granted, NEVER_WRITE_PATHS, GRANT_EXCLUDED_PATHS).strayed, `${f} on a ${own.id} PR`).toEqual([f])
        expect(planScopeGrants([f], own, grantable).refused, `${f} on a ${own.id} PR`).toEqual([{ file: f, reason: 'grant-excluded' }])
      }
    }
  })

  it('the relaxed half still works: ordinary root files are grantable, so one label covers them', () => {
    const backend = lane('backend')
    for (const f of GRANTABLE_ROOT) {
      expect(planScopeGrants([f], backend, grantable).refused, f).toEqual([])
      expect(checkScopeAcross([f], backend.scope, [lane('infra').scope], NEVER_WRITE_PATHS, GRANT_EXCLUDED_PATHS).strayed, f).toEqual([])
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
  const across = (files: string[], own: Lane, granted: Lane[]) =>
    checkScopeAcross(files, own.scope, granted.map((g) => g.scope), NEVER_WRITE_PATHS, GRANT_EXCLUDED_PATHS).strayed

  it('the runbook is reachable by a PR that also touches apps/worker/lib/config.ts — as one commit, from either lane', () => {
    expect(tracked).toContain(RUNBOOK)
    // A backend PR owns the whole diff outright, with no grant at all.
    expect(across(PR_2957, lane('backend'), [])).toEqual([])
    // #2957 as it was actually opened — an infra PR — needs exactly one grant, and the planner can make it.
    expect(across(PR_2957, lane('infra'), [])).toEqual(PR_2957.filter((f) => f.startsWith('apps/worker/')))
    expect(across(PR_2957, lane('infra'), [lane('backend')])).toEqual([])
    const plan = planScopeGrants(PR_2957, lane('infra'), grantable)
    expect(plan.refused).toEqual([])
    expect(plan.grants).toEqual(['backend'])
  })

  it('the allow is not a blanket: a lane still cannot write another lane\'s code', () => {
    expect(across(['apps/worker/lib/config.ts'], lane('desktop'), [])).toEqual(['apps/worker/lib/config.ts'])
    expect(across(['apps/worker/lib/config.ts'], lane('infra'), [lane('desktop')])).toEqual(['apps/worker/lib/config.ts'])
    expect(across(['src/client/routes/x.tsx'], lane('infra'), [])).toEqual(['src/client/routes/x.tsx'])
    // …and a docs-owning lane gets docs, not the code those docs describe.
    expect(across(['apps/worker/lib/config.ts', 'docs/runbooks/rollback.md'], lane('infra'), [])).toEqual(['apps/worker/lib/config.ts'])
  })

  it('the mac runbook stays with the mac fragment: infra does not take it back through docs/', () => {
    expect(checkScope([MAC_RUNBOOK], lane('infra').scope, []).strayed).toEqual([MAC_RUNBOOK])
    for (const l of lanes) {
      if (l.id === 'infra') continue
      expect(checkScope([MAC_RUNBOOK], l.scope, []).strayed, `${l.id} must not own the mac runbook`).toEqual([MAC_RUNBOOK])
    }
    // Still granted, and only by the narrow scope-only grant: scope:mac carries exactly this one file.
    expect(across([MAC_RUNBOOK], lane('infra'), [lane('backend')])).toEqual([MAC_RUNBOOK])
    expect(across([MAC_RUNBOOK], lane('infra'), [lane('mac')])).toEqual([])
    const plan = planScopeGrants([MAC_RUNBOOK, 'docs/runbooks/deploy-official.md'], lane('infra'), grantable)
    expect(plan.refused).toEqual([])
    expect(plan.grants).toEqual(['mac'])
    expect(plan.filesByLane).toEqual({ mac: [MAC_RUNBOOK] })
  })

  it('the docs tree is owned by infra and by the surface it documents, and nothing is left over', () => {
    const docs = tracked.filter((f) => f.startsWith('docs/'))
    expect(docs.length).toBeGreaterThan(300)
    // Infra owns every doc except the three carve-outs, each of which has its own owner.
    const CARVED_OUT = (f: string): boolean =>
      f === MAC_RUNBOOK || f.startsWith('docs/security/') || f.startsWith('docs/protocol/') || f === 'docs/architecture/E2EE_ARCHITECTURE.md'
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

describe('.github/scripts/ — assigned to infra and withheld from grants (#2875 option 1)', () => {
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

  it('a scope: grant cannot carry another lane onto them — the same treatment as .github/workflows/', () => {
    expect(GRANT_EXCLUDED_PATHS).toContain('.github/scripts/')
    const backend = lanes.find((l) => l.id === 'backend')
    if (backend === undefined) throw new Error('no backend lane')
    for (const f of SCRIPTS) {
      expect(planScopeGrants([f], backend, lanes).refused, f).toEqual([{ file: f, reason: 'grant-excluded' }])
    }
  })

  it('no compiled Python artifact is tracked under it', () => {
    expect(tracked.filter((f) => f.includes('__pycache__/') || f.endsWith('.pyc'))).toEqual([])
  })
})
