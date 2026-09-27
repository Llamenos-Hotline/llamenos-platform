/**
 * Executes a GitHub Actions `run:` block the way the runner does, so a rail
 * can assert what a step *produces* rather than what its YAML *says*.
 *
 * Why this exists: Actions has no lowercase function in `${{ }}` expressions
 * and `with:` inputs are not shell, so a fix written at a `with:` use site is
 * inert text that reads as correct. Likewise, a step that derives an address
 * from a file is only correct if it actually reads that file. Neither
 * property is visible to a YAML text match — both are visible to running the
 * block and reading `$GITHUB_OUTPUT`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

export interface WorkflowStep {
  name?: string
  id?: string
  run?: string
  uses?: string
  with?: Record<string, string>
  env?: Record<string, string>
  'continue-on-error'?: boolean
}
export interface WorkflowJob {
  env?: Record<string, string>
  permissions?: Record<string, string>
  steps: WorkflowStep[]
}
export interface WorkflowDoc {
  env?: Record<string, string>
  jobs: Record<string, WorkflowJob>
}

export const WORKFLOWS_DIR = join(process.cwd(), '.github', 'workflows')

export function loadWorkflow(file: string): WorkflowDoc {
  return parseYaml(readFileSync(join(WORKFLOWS_DIR, file), 'utf8')) as WorkflowDoc
}

export function getJob(doc: WorkflowDoc, name: string): WorkflowJob {
  const j = doc.jobs?.[name]
  if (!j) throw new Error(`no "${name}" job — the parser must not pass vacuously`)
  return j
}

export function getStep(j: WorkflowJob, name: string): WorkflowStep {
  const s = j.steps.find((s) => s.name === name)
  if (!s) throw new Error(`no "${name}" step — the parser must not pass vacuously`)
  return s
}

/**
 * Substitutes the runner-supplied `${{ ... }}` values an env block may read.
 * An expression with no fixture throws rather than quietly handing the shell
 * an unexpanded literal, which would make any assertion on the result
 * meaningless.
 */
export function resolveEnv(
  raw: Record<string, string> | undefined,
  fixtures: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw ?? {})) {
    out[k] = String(v).replaceAll(/\$\{\{\s*([^}\s]+)\s*\}\}/g, (_m, path: string) => {
      const fixture = fixtures[path]
      if (fixture === undefined) {
        throw new Error(`env "${k}" reads \${{ ${path} }}, which this rail has no fixture for`)
      }
      return fixture
    })
  }
  return out
}

export interface RunResult {
  outputs: Record<string, string>
  stdout: string
  stderr: string
  status: number
}

/**
 * Runs a `run:` block under bash — the shell GitHub uses for `run:` on
 * ubuntu-latest — with `$GITHUB_OUTPUT` pointed at a temp file, and returns
 * the step outputs together with its exit status. Never throws on a non-zero
 * exit: a rail that asserts a step *fails loudly* needs to inspect that.
 */
export function runShellStep(
  script: string,
  env: Record<string, string>,
  cwd: string = process.cwd(),
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-shell-'))
  const outputFile = join(dir, 'github_output')
  writeFileSync(outputFile, '')

  let stdout = ''
  let stderr = ''
  let status = 0
  try {
    stdout = execFileSync('bash', ['-eo', 'pipefail', '-c', script], {
      cwd,
      env: { PATH: process.env['PATH'] ?? '', ...env, GITHUB_OUTPUT: outputFile },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    status = err.status ?? 1
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? ''
  }

  return { outputs: parseGithubOutput(readFileSync(outputFile, 'utf8')), stdout, stderr, status }
}

/** Parses the `key=value` and `key<<DELIM ... DELIM` forms the runner accepts. */
export function parseGithubOutput(raw: string): Record<string, string> {
  const outputs: Record<string, string> = {}
  const lines = raw.split('\n')
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
