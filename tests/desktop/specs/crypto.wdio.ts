/**
 * Crypto tests — verify Tauri IPC crypto operations work against the REAL
 * Rust backend (packages/crypto, RFC 9180 HPKE), not the Playwright mock in
 * tests/mocks/hpke-mock.ts (which implements a different, non-RFC-9180
 * primitive purely so the mocked webview build has something to decrypt —
 * see that file's header comment).
 *
 * Drives window.__TAURI_INTERNALS__.invoke() directly since browser.execute()
 * can't resolve bare module specifiers from inside the webview.
 *
 * Tauri converts Rust snake_case command args to camelCase for JS, and every
 * `#[serde(rename_all = "camelCase")]` struct returns camelCase fields too
 * (e.g. `encryptionPubkeyHex`, `labelId`). The IPC surface exercised here is
 * the v3 device-key API registered in apps/desktop/src/lib.rs:173-233 —
 * migrated off the pre-HPKE nsec commands (generate_keypair, is_valid_nsec,
 * get_public_key, key_pair_from_nsec, encrypt_with_pin, decrypt_with_pin)
 * that no longer exist anywhere in apps/desktop/src (#1126).
 *
 * Epic 88: Desktop & Mobile E2E Tests.
 */

/** `device_keys::DeviceKeyState` IPC response (camelCase via serde). */
interface DeviceKeyState {
  deviceId: string
  signingPubkeyHex: string
  encryptionPubkeyHex: string
}

/** `device_keys::EncryptedDeviceKeys` IPC response — includes the public `state`. */
interface EncryptedDeviceKeys {
  kdfVersion: number
  salt: string
  argon2MCost: number
  argon2TCost: number
  argon2PCost: number
  nonce: string
  ciphertext: string
  state: DeviceKeyState
}

/** `hpke_envelope::HpkeEnvelope` IPC response (camelCase via serde). */
interface HpkeEnvelope {
  v: number
  labelId: number
  enc: string
  ct: string
}

describe('Native Crypto IPC', () => {
  it('should detect Tauri environment', async () => {
    // Wait for Tauri internals to be injected — on Windows WebView2, the
    // preload script can lag behind the first test execution.
    await browser.waitUntil(
      async () => {
        const ready = await browser.execute(
          () => typeof window.__TAURI_INTERNALS__?.invoke === 'function',
        )
        return ready === true
      },
      { timeout: 10_000, timeoutMsg: '__TAURI_INTERNALS__ not available after 10s' },
    )

    const result = await browser.execute(() => {
      const internals = window.__TAURI_INTERNALS__
      return {
        hasInternals: typeof internals !== 'undefined',
        hasInvoke: typeof internals?.invoke === 'function',
        hasMetadata: typeof internals?.metadata === 'object',
      }
    })
    expect(result.hasInternals).toBe(true)
    expect(result.hasInvoke).toBe(true)
  })

  it('should generate a device keypair and hold secrets only in Rust (device_generate_and_load)', async () => {
    const result = await browser.execute(async () => {
      try {
        const invoke = window.__TAURI_INTERNALS__?.invoke
        if (!invoke) return { success: false as const, error: 'invoke not available' }

        const encrypted = await invoke('device_generate_and_load', {
          pin: '12345678',
          deviceId: 'wdio-test-device-1',
        }) as EncryptedDeviceKeys

        const unlocked = await invoke('is_crypto_unlocked') as boolean

        return {
          success: true as const,
          deviceId: encrypted.state.deviceId,
          hasSigningPubkey: typeof encrypted.state.signingPubkeyHex === 'string'
            && encrypted.state.signingPubkeyHex.length === 64,
          hasEncryptionPubkey: typeof encrypted.state.encryptionPubkeyHex === 'string'
            && encrypted.state.encryptionPubkeyHex.length === 64,
          // The ciphertext blob must exist — but must NOT be the raw secret.
          hasCiphertext: typeof encrypted.ciphertext === 'string' && encrypted.ciphertext.length > 0,
          unlocked,
        }
      } catch (e: unknown) {
        return { success: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    })

    if (!result.success) throw new Error(`IPC failed: ${result.error}`)
    expect(result.deviceId).toBe('wdio-test-device-1')
    expect(result.hasSigningPubkey).toBe(true)
    expect(result.hasEncryptionPubkey).toBe(true)
    expect(result.hasCiphertext).toBe(true)
    // device_generate_and_load loads the freshly generated secrets into
    // CryptoState immediately — no separate unlock step needed.
    expect(result.unlocked).toBe(true)
  })

  it('should lock, then unlock with the correct PIN via unlock_with_pin (and reject the wrong one)', async () => {
    const result = await browser.execute(async () => {
      try {
        const invoke = window.__TAURI_INTERNALS__?.invoke
        if (!invoke) return { success: false as const, error: 'invoke not available' }

        const pin = '87654321'
        const encrypted = await invoke('device_generate_and_load', {
          pin,
          deviceId: 'wdio-test-device-2',
        }) as EncryptedDeviceKeys

        await invoke('lock_crypto')
        const lockedAfterLock = !(await invoke('is_crypto_unlocked') as boolean)

        // Wrong PIN must be rejected and must NOT unlock the state.
        let wrongPinRejected = false
        try {
          await invoke('unlock_with_pin', { data: encrypted, pin: 'wrong-pin' })
        } catch {
          wrongPinRejected = true
        }
        const stillLockedAfterWrongPin = !(await invoke('is_crypto_unlocked') as boolean)

        // Correct PIN unlocks and returns the public device state.
        const deviceState = await invoke('unlock_with_pin', { data: encrypted, pin }) as DeviceKeyState
        const unlockedAfterCorrectPin = await invoke('is_crypto_unlocked') as boolean

        return {
          success: true as const,
          lockedAfterLock,
          wrongPinRejected,
          stillLockedAfterWrongPin,
          deviceIdMatches: deviceState.deviceId === 'wdio-test-device-2',
          unlockedAfterCorrectPin,
        }
      } catch (e: unknown) {
        return { success: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    })

    if (!result.success) throw new Error(`IPC failed: ${result.error}`)
    expect(result.lockedAfterLock).toBe(true)
    expect(result.wrongPinRejected).toBe(true)
    expect(result.stillLockedAfterWrongPin).toBe(true)
    expect(result.deviceIdMatches).toBe(true)
    expect(result.unlockedAfterCorrectPin).toBe(true)
  })

  it('should round-trip an HPKE (RFC 9180) seal/open through the real Rust crate', async () => {
    const result = await browser.execute(async () => {
      try {
        const invoke = window.__TAURI_INTERNALS__?.invoke
        if (!invoke) return { success: false as const, error: 'invoke not available' }

        // Fresh unlocked device — hpke_open_from_state decrypts with
        // whatever X25519 secret is currently loaded in CryptoState.
        const encrypted = await invoke('device_generate_and_load', {
          pin: '11112222',
          deviceId: 'wdio-test-device-3',
        }) as EncryptedDeviceKeys
        const recipientPubkeyHex = encrypted.state.encryptionPubkeyHex

        const plaintext = 'hello from a real RFC 9180 HPKE roundtrip'
        const plaintextHex = Array.from(new TextEncoder().encode(plaintext))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
        const aadHex = '' // no additional authenticated data for this smoke test

        const envelope = await invoke('hpke_seal', {
          plaintextHex,
          recipientPubkeyHex,
          label: 'llamenos:note-key',
          aadHex,
        }) as HpkeEnvelope

        const decryptedHex = await invoke('hpke_open_from_state', {
          envelope,
          expectedLabel: 'llamenos:note-key',
          aadHex,
        }) as string

        const decrypted = decryptedHex.match(/.{1,2}/g)
          ?.map((byte) => parseInt(byte, 16))
          ?? []
        const decryptedText = new TextDecoder().decode(new Uint8Array(decrypted))

        // Opening with the WRONG label must fail (Albrecht defense — domain
        // separation enforced at decrypt).
        let wrongLabelRejected = false
        try {
          await invoke('hpke_open_from_state', {
            envelope,
            expectedLabel: 'llamenos:message',
            aadHex,
          })
        } catch {
          wrongLabelRejected = true
        }

        return {
          success: true as const,
          envelopeVersion: envelope.v,
          roundTrip: decryptedText === plaintext,
          wrongLabelRejected,
        }
      } catch (e: unknown) {
        return { success: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    })

    if (!result.success) throw new Error(`IPC failed: ${result.error}`)
    expect(result.envelopeVersion).toBe(3)
    expect(result.roundTrip).toBe(true)
    expect(result.wrongLabelRejected).toBe(true)
  })
})
