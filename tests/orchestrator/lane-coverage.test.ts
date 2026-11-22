import { describe, it, expect, beforeAll } from 'vitest'
import { loadLanes, GRANT_EXCLUDED_PATHS, type Lane } from '../../orchestrator/src/config.js'
import { loadLaneScopes, type LaneScope } from '../../orchestrator/src/fragments.js'
import { checkScope } from '../../orchestrator/src/scope.js'
import { planScopeGrants } from '../../orchestrator/src/scope-grant.js'
import { trackedFiles } from './codeowners.js'

/**
 * #2875 — the third occurrence of the #1115 unowned-path class (`orchestrator/`
 * in #1836, `/README.md` + `docs/QUICKSTART.md`, now `.github/scripts/`).
 *
 * A path that no lane's fragment owns is not merely unreviewed. `fleet/verify`
 * reports it as out of scope, no review is ever requested, and no `scope:`
 * grant can reach it, so NO PR can change it. Worse, the gate's own advised
 * remedy (move the file somewhere owned) reads as writing the unowned original
 * under `--no-renames`, so such instances deadlock instead of degrading.
 * Each earlier instance was found only when a PR hit it live.
 *
 * This test finds the next one at the point it is created: every tracked path
 * must be owned by at least one fragment, or be named in `KNOWN_UNOWNED` below.
 * It runs against the REAL fragments, because the failure is a disagreement
 * between what the tree contains and what the fragments declare, which a
 * hand-written lane table cannot reproduce.
 *
 * "Owned" is read from the fragments (`loadLaneScopes`), every `*-supervisor.md`
 * included — `mac` is a fragment rather than a lane (#2600) but its files are
 * owned, just not dispatchable. Ownership is judged exactly as the gate judges
 * it (`checkScope`: longest-match, `Does NOT own` carve-outs honoured).
 */

/**
 * The unowned paths that existed when this test was written, recorded as
 * measured. A directory ends in `/` and covers everything beneath it; anything
 * else is one exact file. Entries are NOT decisions that the path should stay
 * unowned unless the reason says so — they are the backlog this test ratchets
 * down, and the dead-entry test below forces an entry out the moment a fragment
 * starts owning what it names.
 *
 * Adding an entry is a deliberate act that needs a reason a reviewer can
 * disagree with. If you are here because a new file failed the test, the fix
 * is nearly always to assign it to a lane in `.claude/agents/fragments/`, not
 * to list it here.
 */
const KNOWN_UNOWNED: ReadonlyArray<{ paths: readonly string[]; why: string }> = [
  {
    paths: ['docs/'],
    why: 'the docs tree stays unowned apart from docs/QUICKSTART.md and what a fragment names (infra fragment: "the rest of the docs tree stays unowned")',
  },
  {
    paths: ['.claude/'],
    why:
      'agent configuration. The fragments directory is deliberately unowned: a lane able to edit the scope judging it could widen its own authority ' +
      '(infra fragment). The rendered agents, skills and settings beside it were never assigned',
  },
  {
    paths: [
      '.github/ISSUE_TEMPLATE/', '.github/PULL_REQUEST_TEMPLATE.md', '.github/actionlint.yaml', '.github/actions/',
      '.github/ci/audit-allowlist.txt', '.github/codeql/', '.github/dependabot.yml', '.github/labels.yml',
    ],
    why:
      'the rest of .github/ outside workflows/ and scripts/. Same class as #2875; not assigned there because the operator ruling covered ' +
      '.github/scripts/ only. .github/actions/ is already in GRANT_EXCLUDED_PATHS yet owned by nobody',
  },
  {
    paths: [
      '.codeqlignore', '.dockerignore', '.env.example', '.env.live.example', '.gitignore', '.gitleaks.toml', '.gitleaksignore', '.mcp.json',
      '.mise.toml', '.trivyignore', 'deny.toml', 'dprint.json', 'components.json',
    ],
    why: 'repo-root tool and scanner configuration, never assigned to a lane',
  },
  {
    paths: [
      'AGENTS.md', 'CHANGELOG.md', 'CLAUDE.md', 'CODEOWNERS', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'DEVELOPMENT.md', 'LICENSE',
      'NEXT_BACKLOG.md', 'SECURITY.md', 'counterspy-2026.odp', 'counterspy-2026.pptx',
    ],
    why: 'repo-root governance, policy and project documents (CODEOWNERS is the operator\'s own control and is meant to stay that way)',
  },
  {
    paths: [
      'index.html', 'playwright.docker.config.ts', 'playwright.live.config.ts', 'start-server.sh', 'tsconfig.json', 'tsconfig.tests.json',
      'vite.config.ts', 'vitest.desktop.config.ts', 'vitest.desktop.setup.ts', 'vitest.integration.config.ts', 'vitest.orchestrator.config.ts',
      'vitest.unit.config.ts', 'vitest.unit.setup.ts', 'src/globals.d.ts',
    ],
    why: 'repo-root build and test entry points shared by every client lane',
  },
  {
    paths: ['public/', 'flatpak/'],
    why: 'desktop packaging and static assets that no fragment lists',
  },
]

/** True when `file` is covered by one `KNOWN_UNOWNED` entry. */
function covers(entry: string, file: string): boolean {
  return entry.endsWith('/') ? file.startsWith(entry) : file === entry
}

let scopes: LaneScope[]
let tracked: string[]
let lanes: Lane[]
beforeAll(async () => {
  scopes = Object.values(await loadLaneScopes(process.cwd()))
  tracked = trackedFiles()
  lanes = await loadLanes(process.cwd())
})

const owned = (file: string): boolean =>
  scopes.some((s) => s.owned.length > 0 && checkScope([file], s, []).strayed.length === 0)

const knownUnowned = (file: string): boolean => KNOWN_UNOWNED.some((g) => g.paths.some((p) => covers(p, file)))

describe('every tracked path maps to at least one lane (#2875, #1115)', () => {
  it('no tracked file is owned by nobody, unless KNOWN_UNOWNED names it', () => {
    const orphans = tracked.filter((f) => !owned(f) && !knownUnowned(f))
    // Printed whole: the remedy is to assign the directory in a fragment, and the
    // reviewer needs to see which directory without re-running the scan.
    expect(orphans, `owned by no lane and not in KNOWN_UNOWNED:\n  ${orphans.join('\n  ')}`).toEqual([])
  })

  it('every KNOWN_UNOWNED entry still names an unowned file — an owned or vanished one is dead and must go', () => {
    const dead = KNOWN_UNOWNED.flatMap((g) => g.paths).filter((p) => !tracked.some((f) => covers(p, f) && !owned(f)))
    expect(dead, 'entries that cover no unowned tracked file — delete them').toEqual([])
  })

  it('the scan is not vacuous: fragments own real paths and the known-unowned set is a minority of the tree', () => {
    expect(scopes.filter((s) => s.owned.length > 0).length).toBeGreaterThanOrEqual(6)
    expect(tracked.filter(owned).length).toBeGreaterThan(tracked.length / 2)
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
