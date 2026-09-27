import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadLaneScopes, type LaneScope } from './fragments.js'
import { FLEET_DIR } from './paths.js'
import type { Limits } from './circuit.js'

export type LaneMode = 'off' | 'shadow' | 'live'
export type EngineId = 'claude' | 'opencode'

export interface Lane {
  id: string
  mode: LaneMode
  cap: number
  engine: EngineId
  model?: string
  requireLabel: string
  vetoLabels: string[]
  /** Filled by loadLanes() from .claude/agents/fragments/<id>-supervisor.md */
  scope: LaneScope
}

export const LANE_IDS = ['backend', 'shared', 'desktop', 'ios', 'android', 'infra'] as const

/**
 * Lane order is claim priority: the first lane to claim an item owns it, so two
 * workers never race the same issue. `shared` sits high because protocol and
 * crypto changes block the client lanes that consume their codegen.
 */
export const LANES: Lane[] = LANE_IDS.map((id) => ({
  id,
  mode: 'off',                       // DEFAULT only — real mode comes from readLaneModes()
  cap: 1,
  engine: 'claude',
  requireLabel: 'agent-dispatchable',
  vetoLabels: ['needs-human', 'needs-decision', 'blocked', 'needs-info'],
  scope: { owned: [], notOwned: [] },
}))

export const LANE_MODES_FILE = join(FLEET_DIR, 'lanes.json')

/**
 * One lane's operator override, parsed from `lanes.json`. `mode` is always
 * present; `engine`/`model` are only meaningful for lanes that should run on
 * a non-default engine (e.g. `opencode` with a Kimi subscription while the
 * Anthropic account is exhausted).
 */
export interface LaneOverride {
  mode: LaneMode
  engine?: EngineId
  model?: string
}

/** Keys a per-lane override object may carry. Anything else is rejected. */
const OVERRIDE_KEYS: ReadonlySet<string> = new Set(['mode', 'engine', 'model'])

function isLaneMode(v: unknown): v is LaneMode {
  return v === 'off' || v === 'shadow' || v === 'live'
}

function isEngineId(v: unknown): v is EngineId {
  return v === 'claude' || v === 'opencode'
}

/**
 * Parses one lane's file entry into an override, or returns a rejection
 * reason. Two shapes are accepted, backward compatible:
 *   "backend": "live"
 *   "backend": {"mode":"live","engine":"opencode","model":"kimi-for-coding/k3-256k"}
 *
 * Fail CLOSED, never throw: any malformed entry — unknown keys, an invalid
 * mode or engine, a non-string model — rejects that one lane (the caller
 * treats it as `off`) and reports the reason through `onReject`. A bad dial
 * must never crash the tick, and must never silently take effect.
 */
function parseLaneOverride(id: string, v: unknown): { override: LaneOverride } | { reason: string } {
  if (typeof v === 'string') {
    if (isLaneMode(v)) return { override: { mode: v } }
    return { reason: `lane "${id}": invalid mode ${JSON.stringify(v)} (expected off|shadow|live)` }
  }
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>
    const unknown = Object.keys(obj).filter((k) => !OVERRIDE_KEYS.has(k))
    if (unknown.length > 0) {
      return { reason: `lane "${id}": unknown override key(s): ${unknown.join(', ')} (allowed: mode, engine, model)` }
    }
    if (!isLaneMode(obj['mode'])) {
      return { reason: `lane "${id}": invalid mode ${JSON.stringify(obj['mode'])} (expected off|shadow|live)` }
    }
    const override: LaneOverride = { mode: obj['mode'] }
    if (obj['engine'] !== undefined) {
      if (!isEngineId(obj['engine'])) {
        return { reason: `lane "${id}": invalid engine ${JSON.stringify(obj['engine'])} (expected claude|opencode)` }
      }
      override.engine = obj['engine']
    }
    if (obj['model'] !== undefined) {
      if (typeof obj['model'] !== 'string' || obj['model'].length === 0) {
        return { reason: `lane "${id}": invalid model ${JSON.stringify(obj['model'])} (expected a non-empty string)` }
      }
      override.model = obj['model']
    }
    return { override }
  }
  return { reason: `lane "${id}": unrecognized entry ${JSON.stringify(v)} (expected a mode string or an override object)` }
}

/** Lane ids the modes file may name — any other key is ignored and reported. */
const LANE_ID_SET: ReadonlySet<string> = new Set(LANE_IDS)

/**
 * Modes live in runtime state, NOT in this source file. Two reasons: a dial
 * meant to be turned must not sit behind the merge gate (orchestrator/ is
 * high-impact, so editing it would require a human-gated PR to change a lane
 * from off to shadow), and a mode baked into source makes the "every lane
 * starts off" test false the moment anyone turns one on.
 *
 * Unknown lane ids and unreadable files both yield the default: off. Unknown
 * ids — including `__proto__`, `constructor`, and `prototype` — are rejected
 * against the LANE_IDS allowlist and reported through `onReject`, never
 * silently kept: a key that is not a real lane can never take effect, so it
 * must surface in the fleet log rather than sit inert in the file.
 *
 * The result map is a null-prototype object (`Object.create(null)`), so a
 * lookup for an unlisted lane can never inherit an override through the
 * prototype chain. This is belt and braces with the allowlist: the allowlist
 * stops a poisoned key from being assigned, and the null prototype means that
 * even if one ever were, `modes[unlistedLane]` still could not find it. A
 * `"__proto__": "live"` entry in lanes.json must fail CLOSED (every lane
 * stays off), not silently turn every lane live.
 *
 * `file` defaults to the real operator state (`LANE_MODES_FILE`, under
 * `~/.llamenos-fleet/`) but is injectable so callers — tests in particular —
 * can point it at a fixture instead of depending on whatever the machine
 * running the test happens to have turned on.
 *
 * `onReject` receives one `(laneId, reason)` call per malformed entry. The
 * entry is excluded from the result either way (fail closed: the lane stays
 * `off`); the callback exists so operators see WHY their lanes.json edit did
 * not take effect, in the fleet log, instead of the file being silently
 * ignored.
 */
export function readLaneModes(
  file: string = LANE_MODES_FILE,
  onReject?: (laneId: string, reason: string) => void,
): Record<string, LaneOverride> {
  if (!existsSync(file)) return {}
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: Record<string, LaneOverride> = Object.create(null)
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!LANE_ID_SET.has(k)) {
        onReject?.(k, `unknown lane id ${JSON.stringify(k)} (expected one of: ${LANE_IDS.join(', ')}) — entry ignored`)
        continue
      }
      const parsed = parseLaneOverride(k, v)
      if ('override' in parsed) out[k] = parsed.override
      else onReject?.(k, parsed.reason)
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Rail 8, ENFORCED rather than merely tested. A live lane with an empty owned
 * list gives the scope breaker nothing to compare a diff against — it is not a
 * lane with wide permissions, it is a lane with no permission check at all.
 * Throwing at load is the safe direction: a startup failure beats a silent
 * unscoped dispatch.
 */
export function assertLiveLanesHaveScope(lanes: Lane[]): void {
  for (const l of lanes) {
    if (l.mode !== 'off' && l.scope.owned.length === 0) {
      throw new Error(
        `lane "${l.id}" is ${l.mode} but parsed no owned paths from ` +
        `.claude/agents/fragments/${l.id}-supervisor.md — refusing to run without a write scope`,
      )
    }
  }
}

export async function loadLanes(
  repoRoot: string,
  modesFile: string = LANE_MODES_FILE,
  onReject?: (laneId: string, reason: string) => void,
): Promise<Lane[]> {
  const scopes = await loadLaneScopes(repoRoot)
  const modes = readLaneModes(modesFile, onReject)
  const lanes = LANES.map((l) => {
    // Object.hasOwn, never `modes[l.id]` unguarded: a lane's override must be
    // an OWN property of the modes map, never something inherited through a
    // (poisoned) prototype chain. readLaneModes already returns a
    // null-prototype map allowlisted to LANE_IDS; this is the second fence.
    const override = Object.hasOwn(modes, l.id) ? modes[l.id] : undefined
    return {
      ...l,
      mode: override?.mode ?? l.mode,
      engine: override?.engine ?? l.engine,
      model: override?.model ?? l.model,
      scope: scopes[l.id] ?? { owned: [], notOwned: [] },
    }
  })
  assertLiveLanesHaveScope(lanes)
  return lanes
}

/**
 * Binds every lane, including one with an empty owned list.
 *
 * `deploy/` and `.github/workflows/` are deliberately NOT here, unlike the
 * original brief. Never-write is for paths a worker must never write AT ALL;
 * those two instead rely on the impact gate — `classifyImpact` already marks
 * both high-impact, so a change touching them can never auto-merge and always
 * reaches a human. As drafted, the ios and android lane fragments declared CI
 * workflow paths (`.github/workflows/ios*.yml`, `.github/workflows/*android*`)
 * as their OWN, but a blanket `.github/workflows/` never-write entry made
 * those paths unwritable regardless — the fleet could never fix its own CI,
 * which is a large share of the near-term work. The merge gate, not the write
 * gate, is what keeps a bad workflow off `main`; verification runs tests in
 * the worktree, so a worker cannot weaken the gate that judges it.
 *
 * Entries with no `/` are basename patterns (see `matchesPath`): `.env`
 * matches `apps/worker/config/.env` at any depth, `keystore.properties`
 * matches `apps/android/keystore.properties`, and `*.pem`/`id_rsa`/
 * `id_ed25519` catch key material wherever a worker might create it.
 *
 * The bare-filename entries are PREFIX matches on the basename, so `.env`
 * also covers `.env.local` and `.env.production` — any environment name,
 * including one nobody has invented yet. The one thing they do NOT cover is
 * a committed template: the never-write gate compares with
 * `matchesSecretPath`, which subtracts `SECRET_TEMPLATE_SUFFIXES`
 * (`.example`/`.sample`/`.template`) from the match. This repo tracks five
 * such files on purpose — `.env.example`, `.env.live.example`,
 * `apps/ios/fastlane/.env.example`, `deploy/docker/.env.example`,
 * `apps/android/keystore.properties.example` — and without that subtraction
 * every one of them is unwritable by every lane forever, which is how a
 * deploy-enabling PR came to fail `fleet/review` for "touched never-write
 * paths: deploy/docker/.env.example". A template is exempt from the WRITE
 * gate only; `classifyImpact` below still rates it high-impact, so it can
 * never auto-merge unreviewed, and `gitleaks` (a required status check)
 * remains the gate that reads its CONTENTS.
 *
 * This list is NOT a mirror of `.claude/settings.json`'s PreToolUse hook —
 * that regex (`\.env$|\.dev\.vars|\.pem$|id_rsa$|id_ed25519$`) is a fast,
 * best-effort bail-out for interactive editing and has already drifted from
 * this one (it does not know about `keystore.properties` or any of the
 * signing-key extensions below). This list is the authoritative, exhaustive
 * one the scope checker enforces; the two are independent defenses and must
 * each be kept correct on their own, not assumed to track each other.
 *
 * `keystore.properties` holds the Android signing key's *password*, not the
 * key itself — `*.jks`/`*.keystore` are the actual Android keystore files.
 * `*.p8`/`*.p12`/`*.pfx`/`*.mobileprovision` cover iOS/macOS signing
 * (App Store Connect API keys, PKCS#12 export, provisioning profiles).
 * `.npmrc`/`.pgpass`/`authorized_keys` cover registry auth tokens, Postgres
 * credentials, and SSH access — none of which are recoverable secrets a
 * revert can undo once exfiltrated.
 *
 * SINGLE SOURCE OF TRUTH for two independent gates: `NEVER_WRITE_PATHS`
 * below (checked by `checkScope` at write/diff time) and `classifyImpact`
 * in `impact.ts` (checked at merge time). A secret pattern that is
 * never-write but not also high-impact is a gap the moment a secret reaches
 * a diff by any route the write gate did not cover — a rename, a symlink, a
 * path the write gate missed — because the merge gate would then wave it
 * through unreviewed. Add new secret patterns here ONLY; both gates pick
 * them up automatically.
 */
export const SECRET_PATH_PATTERNS: readonly string[] = [
  '.env',
  '.dev.vars',
  'keystore.properties',
  '*.pem',
  'id_rsa',
  'id_ed25519',
  '*.jks',
  '*.keystore',
  '*.p8',
  '*.p12',
  '*.pfx',
  '*.key',
  '*.mobileprovision',
  '.npmrc',
  '.pgpass',
  'authorized_keys',
]

export const NEVER_WRITE_PATHS: readonly string[] = SECRET_PATH_PATTERNS

/**
 * Paths a `scope:<lane>` GRANT may never reach, even when the granted lane
 * genuinely owns them (#1115).
 *
 * This is NOT a never-write list and must not be confused with one. The lane
 * that owns these paths still writes them normally on its own PR — infra
 * edits its own workflows, ios edits `.github/workflows/ios*.yml`. What is
 * refused is *widening* someone else's PR onto them via a label.
 *
 * Why grants specifically: `NEVER_WRITE_PATHS` is `SECRET_PATH_PATTERNS` and
 * covers secrets only. `deploy/` and `.github/workflows/` are deliberately
 * excluded from it (see the comment above SECRET_PATH_PATTERNS) precisely
 * because lanes own some of them. So without this list, one self-applied
 * `scope:infra` label would extend any worker's write scope to CI and deploy
 * config — the supply chain that builds, tests, signs and ships the app —
 * and `fleet/verify` would report `scope=pass`. A grant is meant to let a
 * cross-lane CODE fix stay atomic, never to hand a lane the build system.
 *
 * `.github/ci/` is intentionally absent: those are lint/tsc baseline files,
 * already shared-write to backend and desktop by their fragments, and not
 * part of the supply chain.
 */
export const GRANT_EXCLUDED_PATHS: readonly string[] = [
  '.github/workflows/',
  '.github/actions/',
  'deploy/',
  'Dockerfile*',
  'Caddyfile*',
  'knope.toml',
]

export const MAX_ATTEMPTS_PER_ITEM = 3

export const LIMITS: Limits = {
  maxDispatchesPerHour: 8,
  consecutiveFailuresToHalt: 3,
  quotaCooldownMs: 3_600_000,
}

export const PROJECT_COLUMNS = {
  next: 'Next-up',
  inProgress: 'In Progress',
  inReview: 'In Review',
  blocked: 'Blocked',
  done: 'Done',
} as const

export const MIN_BODY_CHARS = 200
