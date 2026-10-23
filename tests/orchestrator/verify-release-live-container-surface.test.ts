import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Rail for verify-release-live's container-image surface.
 *
 * v0.19.19's `docker-stable` job went green while the image it pushed was
 * unpullable by anyone without a token (GHCR creates a package private), and
 * the download page still advertised a namespace frozen at 0.19.18. Nothing
 * checked distribution of the image, so a release that shipped no usable
 * image read as success. The surface closes that; this rail keeps it wired
 * into every place a surface must be listed (config validation, the Summary
 * loop and its `needs`), because a surface that is defined but not aggregated
 * can never turn the run red.
 */

const WORKFLOWS = join(process.cwd(), '.github', 'workflows')
const verifyYml = readFileSync(join(WORKFLOWS, 'verify-release-live.yml'), 'utf8')
const surfaces = JSON.parse(readFileSync(join(WORKFLOWS, 'verify-release-live.surfaces.json'), 'utf8'))
const verify = parseYaml(verifyYml)

describe('verify-release-live container-image surface', () => {
  it('is a required surface in surfaces.json', () => {
    expect(surfaces.surfaces['container-image'].required).toBe(true)
  })

  it('is validated, aggregated and listed in the Summary needs', () => {
    expect(verifyYml).toMatch(/KNOWN="[^"]*\bcontainer-image\b[^"]*"/)
    expect(verifyYml).toMatch(/for ID in [^;]*\bcontainer-image\b[^;]*; do/)
    expect(verify.jobs.report.needs).toContain('container-image')
    expect(verify.jobs.config.outputs['container-image']).toBeDefined()
  })

  it('pulls anonymously: never sends the runner token to the registry', () => {
    const steps = verify.jobs['container-image'].steps as Array<{ run?: string }>
    const script = steps.map((s) => s.run ?? '').join('\n')
    expect(script).toContain('https://ghcr.io/token')
    expect(script).not.toMatch(/docker\/login|docker login|-u\s+["$]|--user/)
    // the only credential in scope is for `gh release list`, never ghcr.io
    expect(script).not.toMatch(/Bearer \$GH_TOKEN|Bearer \$\{GH_TOKEN/)
  })
})
