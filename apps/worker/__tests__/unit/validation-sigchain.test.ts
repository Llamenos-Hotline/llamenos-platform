/**
 * OpenAPI request validation tests for sigchain routes.
 *
 * Sigchain is security-critical — validates Ed25519 signatures, hash-chain
 * continuity, and link types. Schemas live in packages/protocol/schemas/sigchain.ts.
 */
import { describe, it, expect } from 'vitest'
import sigchainRoutes from '../../routes/sigchain'
import {
  createTestApp,
  sendJSON,
  VALID_PUBKEY,
  VALID_SIGNATURE,
  VALID_HASH,
} from '../helpers/openapi-validation'

function createApp() {
  // Sigchain is mounted at /users/:targetPubkey/sigchain in the real app.
  // We need to use the :targetPubkey param pattern so the handler can read it.
  return createTestApp({
    prefix: '/users/:targetPubkey/sigchain',
    routes: sigchainRoutes,
    authenticated: true,
    pubkey: VALID_PUBKEY,
  })
}

const SIGCHAIN_PATH = `/users/${VALID_PUBKEY}/sigchain`

describe('sigchain route validation', () => {
  // -----------------------------------------------------------------------
  // POST /sigchain (append link)
  // -----------------------------------------------------------------------
  describe('POST /sigchain', () => {
    const VALID_LINK = {
      seqNo: 1,
      linkType: 'genesis',
      payload: { type: 'user_init', deviceId: 'dev-1', devicePubkey: VALID_PUBKEY, deviceEncryptionPubkey: VALID_PUBKEY },
      signature: VALID_SIGNATURE,
      prevHash: '',
      hash: VALID_HASH,
      signerDeviceId: 'dev-1',
      signerPubkey: VALID_PUBKEY,
      timestamp: '2026-01-01T00:00:00Z',
    }

    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, SIGCHAIN_PATH, {})
      expect(res.status).toBe(400)
    })

    it('rejects missing seqNo', async () => {
      const app = createApp()
      const { seqNo: _, ...body } = VALID_LINK
      const res = await sendJSON(app, SIGCHAIN_PATH, body)
      expect(res.status).toBe(400)
    })

    it('rejects seqNo 0 (genesis is seq 1, matching packages/crypto verify_sigchain)', async () => {
      const app = createApp()
      const res = await sendJSON(app, SIGCHAIN_PATH, {
        ...VALID_LINK,
        seqNo: 0,
      })
      expect(res.status).toBe(400)
    })

    it('rejects negative seqNo', async () => {
      const app = createApp()
      const res = await sendJSON(app, SIGCHAIN_PATH, {
        ...VALID_LINK,
        seqNo: -1,
      })
      expect(res.status).toBe(400)
    })

    it('rejects fractional seqNo', async () => {
      const app = createApp()
      const res = await sendJSON(app, SIGCHAIN_PATH, {
        ...VALID_LINK,
        seqNo: 1.5,
      })
      expect(res.status).toBe(400)
    })

    it('rejects invalid linkType', async () => {
      const app = createApp()
      const res = await sendJSON(app, SIGCHAIN_PATH, {
        ...VALID_LINK,
        linkType: 'invalid_type',
      })
      expect(res.status).toBe(400)
    })

    it('rejects missing linkType', async () => {
      const app = createApp()
      const { linkType: _, ...body } = VALID_LINK
      const res = await sendJSON(app, SIGCHAIN_PATH, body)
      expect(res.status).toBe(400)
    })

    it('rejects signature that is not 128 hex chars', async () => {
      const app = createApp()
      const res = await sendJSON(app, SIGCHAIN_PATH, {
        ...VALID_LINK,
        signature: 'tooshort',
      })
      expect(res.status).toBe(400)
    })

    it('rejects signature with non-hex characters', async () => {
      const app = createApp()
      const res = await sendJSON(app, SIGCHAIN_PATH, {
        ...VALID_LINK,
        signature: 'g'.repeat(128),
      })
      expect(res.status).toBe(400)
    })

    it('rejects hash that is not 64 hex chars', async () => {
      const app = createApp()
      const res = await sendJSON(app, SIGCHAIN_PATH, {
        ...VALID_LINK,
        hash: 'short',
      })
      expect(res.status).toBe(400)
    })

    it('rejects prevHash with invalid format (not 64-hex or empty)', async () => {
      const app = createApp()
      const res = await sendJSON(app, SIGCHAIN_PATH, {
        ...VALID_LINK,
        prevHash: 'invalid',
      })
      expect(res.status).toBe(400)
    })

    it('accepts valid genesis link', async () => {
      const app = createApp()
      const res = await sendJSON(app, SIGCHAIN_PATH, VALID_LINK)
      // Should pass validation (not 400); may fail in handler (e.g., 403 or 500)
      expect(res.status).not.toBe(400)
    })

    it('accepts valid device_add link', async () => {
      const app = createApp()
      const res = await sendJSON(app, SIGCHAIN_PATH, {
        ...VALID_LINK,
        seqNo: 2,
        linkType: 'device_add',
        prevHash: VALID_HASH,
      })
      expect(res.status).not.toBe(400)
    })

    it('accepts all valid linkType values', async () => {
      const app = createApp()
      for (const type of ['genesis', 'device_add', 'device_remove', 'key_rotate', 'puk_epoch']) {
        const res = await sendJSON(app, SIGCHAIN_PATH, {
          ...VALID_LINK,
          linkType: type,
        })
        expect(res.status).not.toBe(400)
      }
    })

    it('accepts uppercase hex in signature (regex is case-insensitive)', async () => {
      const app = createApp()
      const res = await sendJSON(app, SIGCHAIN_PATH, {
        ...VALID_LINK,
        signature: 'A'.repeat(128),
      })
      expect(res.status).not.toBe(400)
    })

    it('rejects missing signerDeviceId', async () => {
      const app = createApp()
      const { signerDeviceId: _, ...body } = VALID_LINK
      const res = await sendJSON(app, SIGCHAIN_PATH, body)
      expect(res.status).toBe(400)
    })

    it('rejects missing signerPubkey', async () => {
      const app = createApp()
      const { signerPubkey: _, ...body } = VALID_LINK
      const res = await sendJSON(app, SIGCHAIN_PATH, body)
      expect(res.status).toBe(400)
    })

    it('rejects signerPubkey that is not 64 hex chars', async () => {
      const app = createApp()
      const res = await sendJSON(app, SIGCHAIN_PATH, {
        ...VALID_LINK,
        signerPubkey: 'tooshort',
      })
      expect(res.status).toBe(400)
    })

    it('rejects missing timestamp', async () => {
      const app = createApp()
      const { timestamp: _, ...body } = VALID_LINK
      const res = await sendJSON(app, SIGCHAIN_PATH, body)
      expect(res.status).toBe(400)
    })
  })
})
