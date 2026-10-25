/**
 * The file-only secrets a booting server reads, for tests of `validateConfig`.
 *
 * `BAN_HASH_KEY` is never an environment variable (D6), so an env object
 * cannot carry it; `validateConfig` takes the file reader as its second
 * argument and these fixtures stand in for `/run/secrets`.
 */
export const TEST_BAN_HASH_KEY = 'e'.repeat(64)

/** A `/run/secrets` reader holding exactly the secret files a valid deployment mounts. */
export function secretFiles(files: Record<string, string> = { 'ban-hash-key': TEST_BAN_HASH_KEY }) {
  return (name: string): string | undefined => files[name]
}
