// @suite: repo
// deploy/ansible/scripts/check-caddy-compression.py (#3018): `encode` only on a
// Caddy site that serves public files and proxies nothing, in EVERY Caddy
// config in the repo, so the Compose ingress and the Ansible template cannot
// disagree about whether the API origin is compressed.
//
// The cases that matter are the ones that must FAIL: a guard that cannot fail
// is green on exactly the regression it exists for. The mutation tests at the
// bottom put `encode` back into the real configs and require the guard to name
// the line.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '../../..')
const CHECK = join(REPO, 'deploy/ansible/scripts/check-caddy-compression.py')
const PRODUCTION = join(REPO, 'deploy/docker/Caddyfile.production')
const ANSIBLE = join(REPO, 'deploy/ansible/roles/llamenos-caddy/templates/caddy.j2')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caddy-compression-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function config(rel: string, body: string) {
  const path = join(dir, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

function run(...args: string[]) {
  const p = Bun.spawnSync(['python3', '-I', CHECK, ...args], { cwd: REPO })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const check = () => run('--root', dir, '--min', '1')

describe('check-caddy-compression', () => {
  test('the real repo passes and checks every Caddy config, not a vacuous subset', () => {
    const r = run()
    expect(r.code).toBe(0)
    for (const f of [
      'deploy/docker/Caddyfile',
      'deploy/docker/Caddyfile.production',
      'deploy/ansible/roles/llamenos-caddy/templates/caddy.j2',
      'deploy/ansible/roles/llamenos/templates/caddy.j2',
      'deploy/ansible/templates/caddy.j2',
    ]) {
      expect(r.out).toContain(`  ${f}\n`)
    }
    // templates/compose/caddy.j2 is the Compose project that runs Caddy (YAML), not a Caddyfile.
    expect(r.out).not.toContain('compose/caddy.j2')
  })

  test('encode on a site that serves files and proxies nothing is allowed', () => {
    config('Caddyfile', '{$APP_DOMAIN} {\n\troot * /srv/app\n\tencode gzip zstd\n\tfile_server\n}\n')
    expect(check().code).toBe(0)
  })

  test('encode on a site that proxies a backend fails and names the line', () => {
    config('Caddyfile', 'api.example.org {\n\tencode gzip zstd\n\treverse_proxy app:3000\n}\n')
    const r = check()
    expect(r.code).toBe(1)
    expect(r.out).toContain('Caddyfile:2: site `api.example.org` compresses responses but proxies a backend')
  })

  test('a reverse_proxy nested in a handle still makes the site dynamic', () => {
    config(
      'Caddyfile',
      'mixed.example.org {\n\tencode zstd\n\thandle /assets/* {\n\t\tfile_server\n\t}\n\thandle {\n\t\treverse_proxy app:3000\n\t}\n}\n',
    )
    expect(check().code).toBe(1)
  })

  test('encode arriving through an imported snippet is caught', () => {
    config(
      'caddy.j2',
      '(compress) {\n    encode gzip\n}\n\n{{ domain }} {\n    reverse_proxy app:3000\n    import compress\n}\n',
    )
    const r = check()
    expect(r.code).toBe(1)
    expect(r.out).toContain('site `{{ domain }}`')
  })

  test('encode on a site that serves no files from disk fails', () => {
    config('Caddyfile', 'x.example.org {\n\tencode gzip\n\trespond "hi"\n}\n')
    const r = check()
    expect(r.code).toBe(1)
    expect(r.out).toContain('serves no files from disk')
  })

  test('Jinja, comments and in-token placeholders do not confuse the block parser', () => {
    config(
      'caddy.j2',
      [
        '{#',
        '  a jinja comment with a { brace',
        '#}',
        '{',
        '    email {{ acme_email }}',
        '}',
        '{% if serve_api | bool %}',
        '{{ api_subdomain }}.{{ domain }} {',
        '    # encode gzip   <- a comment, not a directive',
        '    reverse_proxy app:3000 {',
        '        header_up X-Forwarded-For {remote_host}',
        '    }',
        '}',
        '{% endif %}',
        '',
      ].join('\n'),
    )
    expect(check().code).toBe(0)
  })

  test('an unbalanced config is a parse error, never a pass', () => {
    config('Caddyfile', 'api.example.org {\n\tencode gzip\n\treverse_proxy app:3000\n')
    const r = check()
    expect(r.code).toBe(2)
    expect(r.err).toContain('cannot parse as a Caddyfile')
  })

  test('finding fewer configs than the floor is an error, never a pass', () => {
    const r = run('--root', dir, '--min', '1')
    expect(r.code).toBe(2)
    expect(r.err).toContain('Found only 0 Caddy config(s)')
  })
})

// Break the gate on purpose (audit gates by breaking them): re-add the exact
// line #3018 removed, in a copy of each real config, and require the guard to
// fail on it.
describe('mutations of the real configs', () => {
  test('re-adding encode to the API origin of Caddyfile.production fails', () => {
    const src = readFileSync(PRODUCTION, 'utf8')
    const mutated = src.replace('{$API_DOMAIN} {\n', '{$API_DOMAIN} {\n\tencode gzip zstd\n')
    expect(mutated).not.toBe(src)
    config('docker/Caddyfile.production', mutated)
    const r = check()
    expect(r.code).toBe(1)
    expect(r.out).toContain('site `{$API_DOMAIN}` compresses responses but proxies a backend')
  })

  test('adding encode to the security_headers snippet of the Ansible template fails', () => {
    const src = readFileSync(ANSIBLE, 'utf8')
    const mutated = src.replace('(security_headers) {\n', '(security_headers) {\n    encode gzip zstd\n')
    expect(mutated).not.toBe(src)
    config('ansible/caddy.j2', mutated)
    const r = check()
    expect(r.code).toBe(1)
    expect(r.out).toContain('compresses responses but proxies a backend')
  })
})
