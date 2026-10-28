/**
 * The file-only secrets a booting server reads, for tests of `validateConfig`.
 *
 * `BAN_HASH_KEY` and `MESSAGING_HASH_KEY` are never environment variables (D6),
 * so an env object cannot carry them; `validateConfig` takes the file reader as its second
 * argument and these fixtures stand in for `/run/secrets`.
 */
export const TEST_BAN_HASH_KEY = 'e'.repeat(64)
export const TEST_MESSAGING_HASH_KEY = 'f'.repeat(64)

/** A `/run/secrets` reader holding exactly the secret files a valid deployment mounts. */
export function secretFiles(files: Record<string, string> = {
  'ban-hash-key': TEST_BAN_HASH_KEY,
  'messaging-hash-key': TEST_MESSAGING_HASH_KEY,
}) {
  return (name: string): string | undefined => files[name]
}
