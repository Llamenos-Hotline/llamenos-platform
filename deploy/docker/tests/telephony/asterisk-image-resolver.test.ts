/**
 * The PBX image carries a DNS resolver module (#1690).
 *
 * The pinned upstream image is built without libunbound, so it has only
 * Asterisk's built-in system resolver, which asks resolv.conf's nameservers and
 * never reads /etc/hosts: a SIP target known only from a hosts entry ends in
 * res_pjsip's "0 viable targets", which reads like a typo in the config.
 * `Dockerfile.asterisk` adds `res_resolver_unbound` to that vetted image.
 *
 * What this file can assert statically is that the compose files actually BUILD
 * that Dockerfile — swapping `build:` back to a bare `image:` would silently
 * drop the module, and nothing else in the unit tier would notice. That the
 * module loads and resolves is measured against a live PBX by
 * run-asterisk-name-resolution.sh, which also runs the unmodified image as a
 * control so it cannot pass vacuously.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const DOCKER = path.resolve(__dirname, '../..')
const read = (file: string) => readFileSync(path.join(DOCKER, file), 'utf8')

/** The body of one top-level service in a compose file. */
function service(compose: string, name: string): string {
  const start = compose.search(new RegExp(`^  ${name}:\\s*$`, 'm'))
  expect(start, `no ${name} service`).toBeGreaterThanOrEqual(0)
  const rest = compose.slice(start + 1)
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('the Asterisk image ships a DNS resolver module', () => {
  for (const file of ['docker-compose.yml', 'docker-compose.dev.yml']) {
    it(`${file} builds the asterisk service from Dockerfile.asterisk`, () => {
      const body = service(read(file), 'asterisk')
      expect(body).toMatch(/^ {4}build:\s*\n(?: {6}.*\n)*? {6}dockerfile: Dockerfile\.asterisk$/m)
      // A bare upstream image would drop the module without any other signal.
      expect(body).not.toMatch(/^ {4}image: andrius\/asterisk/m)
    })

    it(`${file} marks the locally built asterisk image as never pulled`, () => {
      // `llamenos-asterisk:local` exists in no registry. bootstrap-backend runs
      // `docker compose pull asterisk` before it starts the telephony profile;
      // without pull_policy: build that pull fails "pull access denied", the
      // start step is skipped on the strength of it, and sip-bridge never comes
      // up on :3001 — every @telephony backend-bdd scenario then fails (#2030).
      expect(service(read(file), 'asterisk')).toMatch(/^ {4}pull_policy: build$/m)
    })
  }

  describe('the Ansible-deployed PBX gets the same image', () => {
    const ANSIBLE_ROLE = path.resolve(DOCKER, '../ansible/roles/llamenos-asterisk')
    const template = readFileSync(path.join(ANSIBLE_ROLE, 'templates/compose/asterisk.j2'), 'utf8')
    const tasks = readFileSync(path.join(ANSIBLE_ROLE, 'tasks/main.yml'), 'utf8')

    it('builds the asterisk service from Dockerfile.asterisk and never pulls it', () => {
      const body = service(template, 'asterisk')
      expect(body).toMatch(/^ {4}build:\s*\n(?: {6}.*\n)*? {6}dockerfile: Dockerfile\.asterisk$/m)
      expect(body).toMatch(/^ {4}pull_policy: build$/m)
      // The bare upstream image has no resolver module: #1690 on a deployed PBX.
      expect(body).not.toMatch(/^ {4}image: .*andrius\/asterisk/m)
    })

    it('ships the Dockerfile beside the compose file and builds on start', () => {
      expect(tasks).toMatch(/docker\/Dockerfile\.asterisk/)
      expect(tasks).toMatch(/dest: "\{\{ app_dir \}\}\/services\/asterisk\/Dockerfile\.asterisk"/)
      expect(tasks).toMatch(/- name: Start asterisk service[\s\S]*?build: always/)
    })
  })

  const dockerfile = read('Dockerfile.asterisk')

  it('builds the module with libunbound and fails the build if configure misses it', () => {
    expect(dockerfile).toContain('--with-unbound')
    expect(dockerfile).toContain('libunbound-dev')
    expect(dockerfile).toMatch(/HAVE_UNBOUND/)
    expect(dockerfile).toContain('res_resolver_unbound.so')
  })

  it('installs the runtime library the module links against', () => {
    expect(dockerfile).toMatch(/apt-get install[^\n]*libunbound8/)
  })

  it('leaves the image on the unprivileged asterisk user', () => {
    // Trivy DS-0002 (dockerfile-scan, required): no USER means root by default.
    // Compose overrides it to root for the entrypoint's chown, so the image
    // default is the only thing that keeps a bare `docker run` unprivileged.
    const finalStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '))
    const users = [...finalStage.matchAll(/^USER (\S+)$/gm)].map((m) => m[1])
    expect(users.at(-1)).toBe('asterisk')
  })

  it('verifies the Asterisk source tarball', () => {
    expect(dockerfile).toMatch(/ARG ASTERISK_SHA256=[0-9a-f]{64}/)
    expect(dockerfile).toContain('sha256sum -c')
  })

  it('compiles the same Asterisk release as the image it is added to', () => {
    // The module is loaded by a binary it was not built with; a different
    // release is refused at load, but the version bump belongs in one place.
    const version = /ARG ASTERISK_VERSION=(\S+)/.exec(dockerfile)?.[1]
    expect(version).toBeTruthy()
    expect(dockerfile).toContain(`# ${version} — NOT below 22.10.0`)
  })
})
