/**
 * Runs ONE hub-chain request through the real crate (`hub_chain::call`, via
 * packages/crypto/ffi.ts `bun:ffi`) for the Node-hosted vitest tiers, whose
 * `@llamenos/crypto/ffi` mock cannot load the crate (#2963). Reads the request
 * JSON on stdin; writes the answer JSON on stdout, or the crate's error
 * message on stderr with exit code 2.
 *
 *   bun apps/worker/__tests__/mocks/hub-chain-crate.ts < request.json
 */
import { CryptoError, hubChainCallJson } from '../../../../packages/crypto/ffi'

const request = await new Response(Bun.stdin.stream()).text()
try {
  process.stdout.write(hubChainCallJson(request))
} catch (e) {
  process.stderr.write(e instanceof CryptoError ? e.message : String(e))
  process.exit(2)
}
