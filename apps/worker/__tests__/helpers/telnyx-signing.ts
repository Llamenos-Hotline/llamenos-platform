/**
 * Telnyx webhook signing for tests: a real Ed25519 key pair and real
 * signatures over `timestamp|body`, exactly as Telnyx signs a TeXML request.
 * Nothing about the verification is stubbed, so a request that verifies here
 * verified for the reason production relies on.
 */

export interface TelnyxSigner {
  /** The base64 raw public key, as `GET /v2/public_key` returns it */
  publicKey: string
  /** Headers that authenticate `body` as a Telnyx request sent at `timestamp` (seconds) */
  sign(body: string, timestamp?: number): Promise<{ 'telnyx-signature-ed25519': string; 'telnyx-timestamp': string }>
}

export async function makeTelnyxSigner(): Promise<TelnyxSigner> {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return {
    publicKey: btoa(String.fromCharCode(...raw)),
    async sign(body, timestamp = Math.floor(Date.now() / 1000)) {
      const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(`${timestamp}|${body}`)))
      return {
        'telnyx-signature-ed25519': btoa(String.fromCharCode(...sig)),
        'telnyx-timestamp': String(timestamp),
      }
    },
  }
}

/** The `GET /v2/public_key` answer for `signer`, for a fetch stub */
export function publicKeyResponse(signer: TelnyxSigner): Response {
  return Response.json({ data: { public_key: signer.publicKey } })
}
