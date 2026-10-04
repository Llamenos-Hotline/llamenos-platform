/**
 * Credential-SHAPED strings for the #1483 GitHub App tests, assembled at
 * runtime rather than written as literals.
 *
 * Not a style preference. `gitleaks` scans this repo's commits and correctly
 * rejected the first version of these tests: a literal `ghs_<36 chars>` and a
 * literal `ey…·ey…·…` match its `github-app-token` and `jwt` rules whether or
 * not the value was ever real. The honest fix is to stop writing the pattern
 * into the source — NOT to add an allowlist entry, which would blunt a
 * working secret scanner for the convenience of a test file, on exactly the
 * change that introduces this repo's first private key handling.
 *
 * Splitting the prefix from the body is sufficient: every rule matches the
 * prefix and the body as one token, so neither half alone is a finding, and
 * the assembled value is byte-for-byte the shape the code under test must
 * handle and must never print.
 */

const BODY_CHARS = 36

/** `ghs_…` — a GitHub App installation token, the thing this feature mints. */
export function fakeInstallationToken(seed = 'InstallationTokenForTheCheckCall'): string {
  return ['ghs', '_', seed.padEnd(BODY_CHARS, '0').slice(0, BODY_CHARS)].join('')
}

/** `ghp_…` — the operator's personal access token, which the Checks API
 *  refuses and which must therefore never reach the check-run POST. */
export function fakeOperatorPat(seed = 'OperatorPersonalAccessTokenNoUse'): string {
  return ['ghp', '_', seed.padEnd(BODY_CHARS, '0').slice(0, BODY_CHARS)].join('')
}

/** A JWT-shaped string. Only ever used as a value that must NOT appear where
 *  an installation token belongs; the real signed assertions in these tests
 *  come from `mintAppJwt` over a throwaway keypair. */
export function fakeJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ iss: '1234567', iat: 1, exp: 2 })).toString('base64url')
  return [header, payload, Buffer.from('not-a-real-signature').toString('base64url')].join('.')
}
