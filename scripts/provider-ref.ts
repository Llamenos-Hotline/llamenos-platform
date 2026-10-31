/**
 * Turn a provider's call, recording or message identifier into the ref our logs and audit
 * rows carry in its place (#2333), so an operator can find one failed call:
 *
 *   docker compose exec app bun scripts/provider-ref.ts CA0123456789abcdef0123456789abcdef
 *   → pr_a7d6ba752f9bb897
 *   docker compose logs app | grep pr_a7d6ba752f9bb897
 *
 * Reads HMAC_SECRET from the environment of the process it runs in, so run it where the
 * app runs. Several identifiers may be given; each is printed with its ref.
 */
import { providerRef, UNKEYED_PROVIDER_REF } from '../apps/worker/lib/provider-ref'

const ids = process.argv.slice(2)
if (ids.length === 0) {
  console.error('usage: bun scripts/provider-ref.ts <provider call/recording/message id>...')
  process.exit(2)
}
const refs = ids.map((id) => ({ id, ref: providerRef(id) }))
if (refs.some(({ ref }) => ref === UNKEYED_PROVIDER_REF)) {
  console.error('HMAC_SECRET is not set to 64 hex characters in this environment, so no ref can be computed.')
  process.exit(1)
}
for (const { id, ref } of refs) console.log(ids.length === 1 ? ref : `${id}\t${ref}`)
