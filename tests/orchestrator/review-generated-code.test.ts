import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionGeneratedCode, generatedCodeNote } from '../../orchestrator/src/review.js'

// Its own file, not review.test.ts: that file mocks `node:child_process`
// wholesale, which would turn the real-codegen test below into a no-op that
// passes in 13ms.

// #1763/#1844/#1736: `packages/protocol/generated/` is gitignored, so the
// reviewer's `git archive` export had no generated types and the reviewer
// invented names that don't exist (a false REJECTED on #1811 claimed `Tag`
// was nonexistent). The codegen must reach the export — but never by
// executing the judged commit's own code (#665).
describe('provisionGeneratedCode', () => {
  let exportDir: string
  let trusted: string

  beforeEach(() => {
    exportDir = mkdtempSync(join(tmpdir(), 'llamenos-export-'))
    trusted = mkdtempSync(join(tmpdir(), 'llamenos-trusted-'))
  })
  afterEach(() => {
    rmSync(exportDir, { recursive: true, force: true })
    rmSync(trusted, { recursive: true, force: true })
  })

  const asRepoExport = (): void => {
    mkdirSync(join(exportDir, 'packages/protocol/schemas'), { recursive: true })
  }
  const writeGenerated = (root: string): void => {
    mkdirSync(join(root, 'packages/protocol/generated/kotlin'), { recursive: true })
    writeFileSync(join(root, 'packages/protocol/generated/kotlin/Types.kt'), 'data class Tag(val id: String)\n')
  }

  it('copies the trusted checkout\'s generated output into the export', async () => {
    asRepoExport()
    const runCodegen = vi.fn(async (root: string) => { writeGenerated(root) })
    const status = await provisionGeneratedCode(exportDir, trusted, runCodegen)
    expect(status).toEqual({ kind: 'provisioned' })
    expect(readFileSync(join(exportDir, 'packages/protocol/generated/kotlin/Types.kt'), 'utf8')).toContain('class Tag')
  })

  // The invariant that makes this safe: the export is the PR's tree, and
  // running its codegen.ts (or importing its schemas) is the PR executing
  // inside its own judge. The codegen runs once, in the trusted root.
  it('runs the codegen in the TRUSTED root and never in the export', async () => {
    asRepoExport()
    const runCodegen = vi.fn(async (root: string) => { writeGenerated(root) })
    await provisionGeneratedCode(exportDir, trusted, runCodegen)
    expect(runCodegen).toHaveBeenCalledTimes(1)
    expect(runCodegen).toHaveBeenCalledWith(trusted)
    expect(runCodegen).not.toHaveBeenCalledWith(exportDir)
  })

  it('replaces whatever generated/ the export already carried', async () => {
    asRepoExport()
    mkdirSync(join(exportDir, 'packages/protocol/generated'), { recursive: true })
    writeFileSync(join(exportDir, 'packages/protocol/generated/planted.txt'), 'PR-controlled')
    await provisionGeneratedCode(exportDir, trusted, async (root) => { writeGenerated(root) })
    expect(existsSync(join(exportDir, 'packages/protocol/generated/planted.txt'))).toBe(false)
  })

  it('leaves no symlink in what it copies', async () => {
    asRepoExport()
    await provisionGeneratedCode(exportDir, trusted, async (root) => {
      writeGenerated(root)
      symlinkSync('/etc/passwd', join(root, 'packages/protocol/generated/link'))
    })
    expect(existsSync(join(exportDir, 'packages/protocol/generated/kotlin/Types.kt'))).toBe(true)
    expect(readdirSync(join(exportDir, 'packages/protocol/generated'))).not.toContain('link')
  })

  it('does nothing for an export that is not this repository (no protocol package)', async () => {
    const runCodegen = vi.fn(async () => {})
    expect(await provisionGeneratedCode(exportDir, trusted, runCodegen)).toEqual({ kind: 'not-applicable' })
    expect(runCodegen).not.toHaveBeenCalled()
    expect(generatedCodeNote({ kind: 'not-applicable' })).toBe('')
  })

  it('never throws when the codegen fails — the review loses context, not its verdict', async () => {
    asRepoExport()
    const status = await provisionGeneratedCode(exportDir, trusted, async () => { throw new Error('bun: command not found\nstack...') })
    expect(status).toEqual({ kind: 'unavailable', reason: 'bun: command not found' })
    expect(existsSync(join(exportDir, 'packages/protocol/generated'))).toBe(false)
  })

  it('reports unavailable, not provisioned, when the codegen wrote nothing', async () => {
    asRepoExport()
    const status = await provisionGeneratedCode(exportDir, trusted, async () => {})
    expect(status.kind).toBe('unavailable')
  })

  it('tells the reviewer the generated types are base-derived when provisioned', () => {
    const note = generatedCodeNote({ kind: 'provisioned' })
    expect(note).toContain('packages/protocol/generated/')
    expect(note).toMatch(/BASE commit/)
    expect(note).toMatch(/searching that directory first/)
  })

  it('tells the reviewer absence is NOT evidence when the codegen could not run', () => {
    const note = generatedCodeNote({ kind: 'unavailable', reason: 'bun: command not found' })
    expect(note).toContain('bun: command not found')
    expect(note).toMatch(/do not report any type/i)
  })

  // The real codegen, real default runner: proves the types the reviewer
  // invented a nonexistent `Tag` over are in the export, with no git object
  // database alongside them.
  it('with the real codegen, an export gets the emitted types and still has no .git', async () => {
    asRepoExport()
    const status = await provisionGeneratedCode(exportDir, process.cwd())
    expect(status).toEqual({ kind: 'provisioned' })
    expect(readFileSync(join(exportDir, 'packages/protocol/generated/kotlin/Types.kt'), 'utf8')).toMatch(/\bTag\b/)
    expect(existsSync(join(exportDir, '.git'))).toBe(false)
  }, 180_000)
})

// The choke point: every reviewer's export reaches an engine through
// `invokeVerifierEngine`, so provisioning there leaves no caller (gate head,
// profile review, review-and-merge, operator-box worktree) able to skip it.
// A source-level guard because the function spawns a real engine; the
// behaviour it wires up is covered above.
describe('invokeVerifierEngine wiring', () => {
  const source = readFileSync(join(__dirname, '../../orchestrator/src/review.ts'), 'utf8')
  const body = source.slice(source.indexOf('export async function invokeVerifierEngine('))

  it('provisions generated code from the trusted root before any engine is launched', () => {
    const provisioned = body.indexOf('provisionGeneratedCode(input.exportDir)')
    expect(provisioned).toBeGreaterThan(-1)
    expect(provisioned).toBeLessThan(body.indexOf('runClaudeOnce('))
    expect(provisioned).toBeLessThan(body.indexOf('runKimiOnce('))
  })

  it('hands the engines the note-prefixed prompt, not the bare one', () => {
    const launches = body.slice(0, body.indexOf('salvagePartialVerdict(primaryRun')).match(/(?:runClaudeOnce|runKimiOnce)\(\{[^}]*\}\)/g) ?? []
    expect(launches.length).toBeGreaterThanOrEqual(2)
    for (const call of launches) {
      expect(call).toMatch(/prompt: prompt,|prompt,/)
      expect(call).not.toContain('input.prompt')
    }
  })
})
