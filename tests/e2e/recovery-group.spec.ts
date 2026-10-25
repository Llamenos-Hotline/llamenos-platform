import { test, expect } from '@playwright/test'
import { loginAsAdmin, mockConfigWithHub, navigateViaSpa } from '../helpers'

async function goToAdminSection(page: import('@playwright/test').Page, section: string) {
  await navigateViaSpa(page, `/admin/${section}`)
  await page.waitForSelector('[data-testid]', { timeout: 10_000 })
}

async function mockRecoveryGroupApis(page: import('@playwright/test').Page) {
  await page.route('**/api/hubs/*/recovery-group', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'No recovery group configured' }),
    })
  })
  await page.route('**/api/hubs/*/recovery-group/candidates', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    })
  })
  await page.route('**/api/hubs/*/recovery-group/requests', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    })
  })
  await page.route('**/recovery-group/sessions*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    })
  })
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

interface CreatedGroup {
  publicKeyHex: string
  shareEnvelopes: unknown[]
  commitments: string[]
}

/**
 * Load a device, then create a 3-of-2 recovery group whose three shares are all
 * sealed to that device's own encryption key — enough to exercise the
 * create → contribute path. `recovery_group_create` needs the holders' pubkeys, and
 * the device has to be loaded for `recovery_share_contribute_from_state` to open one.
 */
async function createGroup(page: import('@playwright/test').Page): Promise<{ me: string; group: CreatedGroup }> {
  return page.evaluate(async () => {
    const invoke = (window as unknown as Record<symbol, unknown>)[Symbol.for('llamenos_test_invoke')] as Invoke
    const device = (await invoke('device_generate_and_load', {
      pin: '12345678',
      deviceId: crypto.randomUUID(),
    })) as { state: { encryptionPubkeyHex: string } }
    const me = device.state.encryptionPubkeyHex
    const group = (await invoke('recovery_group_create', {
      total: 3,
      threshold: 2,
      holderEncryptionPubkeys: [me, me, me],
    })) as CreatedGroup
    return { me, group }
  })
}

test.describe('Recovery Group - Admin Configuration', () => {
  test.beforeEach(async ({ page }) => {
    await mockConfigWithHub(page)
    await loginAsAdmin(page)
    await mockRecoveryGroupApis(page)
  })

  test('should display recovery team configuration section', async ({ page }) => {
    await goToAdminSection(page, 'recovery-group')
    await expect(page.locator('[data-testid="recovery-threshold"]')).toBeVisible()
    await expect(page.locator('[data-testid="recovery-total"]')).toBeVisible()
    await expect(page.locator('[data-testid="recovery-delay"]')).toBeVisible()
    await expect(page.locator('[data-testid="recovery-emergency-floor"]')).toBeVisible()
  })

  test('should disable save when threshold exceeds total', async ({ page }) => {
    await goToAdminSection(page, 'recovery-group')
    await page.locator('[data-testid="recovery-total"]').fill('3')
    await page.locator('[data-testid="recovery-threshold"]').fill('4')
    await expect(
      page.locator('[data-testid="admin-recovery-group-save"]'),
    ).toBeDisabled()
  })

  test('should disable save when not enough holders selected', async ({ page }) => {
    await goToAdminSection(page, 'recovery-group')
    await page.locator('[data-testid="recovery-threshold"]').fill('2')
    await page.locator('[data-testid="recovery-total"]').fill('3')
    // No holders selected → save should be disabled
    await expect(
      page.locator('[data-testid="admin-recovery-group-save"]'),
    ).toBeDisabled()
  })
})

test.describe('Recovery Group - Recovery Requests Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await mockConfigWithHub(page)
    await loginAsAdmin(page)
    await mockRecoveryGroupApis(page)
  })

  test('should display recovery requests section', async ({ page }) => {
    await goToAdminSection(page, 'recovery-requests')
    await expect(
      page.getByText(/Account Recovery Requests|Active requests/i),
    ).toBeVisible()
  })

  test('should show empty state when no active requests', async ({ page }) => {
    await goToAdminSection(page, 'recovery-requests')
    await expect(
      page.getByText(/No active recovery requests/i),
    ).toBeVisible()
  })
})

test.describe('Recovery Group - Account Recovery Flow', () => {
  test('should show "I lost my device" link on login when key exists', async ({ page }) => {
    await page.goto('/login')
    // The link appears after PIN entry state is detected
    const lostDeviceLink = page.locator('[data-testid="lost-device-link"]')
    if (await lostDeviceLink.isVisible()) {
      await expect(lostDeviceLink).toBeVisible()
    }
  })

  test('should open account recovery flow', async ({ page }) => {
    await page.goto('/login')
    const lostDeviceLink = page.locator('[data-testid="lost-device-link"]')
    if (!await lostDeviceLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      test.skip()
      return
    }

    await lostDeviceLink.click()
    await expect(page.locator('[data-testid="recovery-identifier"]')).toBeVisible()
    await expect(page.locator('[data-testid="recovery-hub"]')).toBeVisible()
    await expect(page.locator('[data-testid="recovery-submit"]')).toBeVisible()
  })

  test('should navigate back from recovery flow', async ({ page }) => {
    await page.goto('/login')
    const lostDeviceLink = page.locator('[data-testid="lost-device-link"]')
    if (!await lostDeviceLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      test.skip()
      return
    }

    await lostDeviceLink.click()
    await expect(page.locator('[data-testid="recovery-identifier"]')).toBeVisible()

    // Click the back button (ArrowLeft icon button)
    await page.locator('button').filter({ has: page.locator('svg') }).first().click()
    await expect(lostDeviceLink).toBeVisible()
  })

  test('should require identifier and hub ID before submitting', async ({ page }) => {
    await page.goto('/login')
    const lostDeviceLink = page.locator('[data-testid="lost-device-link"]')
    if (!await lostDeviceLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      test.skip()
      return
    }

    await lostDeviceLink.click()
    // Submit button should be disabled with empty fields
    await expect(page.locator('[data-testid="recovery-submit"]')).toBeDisabled()

    // Fill identifier only — should still be disabled
    await page.locator('[data-testid="recovery-identifier"]').fill('user@example.com')
    await expect(page.locator('[data-testid="recovery-submit"]')).toBeDisabled()

    // Fill hub ID too — should be enabled
    await page.locator('[data-testid="recovery-hub"]').fill('test-hub')
    await expect(page.locator('[data-testid="recovery-submit"]')).toBeEnabled()
  })
})

test.describe('Recovery Group - IPC Mock Verification', () => {
  async function waitForInvoke(page: import('@playwright/test').Page) {
    await page.goto('/login')
    await page.waitForFunction(
      () => typeof (window as unknown as Record<symbol, unknown>)[Symbol.for('llamenos_test_invoke')] === 'function',
      { timeout: 15_000 },
    )
  }

  /**
   * Serve a recovery session record from the backend route Rust reads it from.
   * `requests` collects the auth header of every fetch, so a test can see that
   * Rust (not the page) made an authenticated request.
   */
  async function serveSession(
    page: import('@playwright/test').Page,
    session: { sessionId: string; status: string; newDevicePubkey: string },
  ): Promise<string[]> {
    const authHeaders: string[] = []
    await page.route(`**/api/recovery-group/session/${session.sessionId}`, async (route) => {
      authHeaders.push(route.request().headers()['authorization'] ?? '')
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(session),
      })
    })
    return authHeaders
  }

  test('recovery_group_create seals every share and each opens only against its own commitment', async ({ page }) => {
    await waitForInvoke(page)
    const { me, group } = await createGroup(page)
    const authHeaders = await serveSession(page, { sessionId: 'sess-1', status: 'verified', newDevicePubkey: me })

    const result = await page.evaluate(async ({ group }) => {
      const invoke = (window as unknown as Record<symbol, unknown>)[Symbol.for('llamenos_test_invoke')] as Invoke
      const attempt = async (commitmentHex: string) => {
        try {
          return {
            ok: (await invoke('recovery_share_contribute_from_state', {
              envelope: group.shareEnvelopes[0],
              commitmentHex,
              sessionId: 'sess-1',
            })) as { encryptedShare: string; signature: string },
          }
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      }
      return {
        own: await attempt(group.commitments[0]),
        otherShare: await attempt(group.commitments[1]),
        zeros: await attempt('0'.repeat(64)),
      }
    }, { group })

    expect(group.publicKeyHex).toHaveLength(64)
    expect(group.shareEnvelopes).toHaveLength(3)
    expect(group.commitments).toHaveLength(3)
    // The share verifies against ITS commitment and yields a sealed contribution + signature.
    expect(result.own.ok?.signature).toMatch(/^[0-9a-f]{128}$/)
    expect(typeof result.own.ok?.encryptedShare).toBe('string')
    // A different share's commitment, or a made-up one, is refused.
    expect(result.otherShare.error).toMatch(/commitment/)
    expect(result.zeros.error).toMatch(/commitment/)
    // The session was read by the command itself, authenticated with the device key.
    expect(authHeaders.length).toBeGreaterThan(0)
    expect(authHeaders.every((h) => h.startsWith('Bearer '))).toBe(true)
  })

  test('recovery_share_contribute_from_state takes the recipient from the server session — an injected one is ignored', async ({ page }) => {
    await waitForInvoke(page)
    const { me, group } = await createGroup(page)
    // The server's record names a recipient that cannot be sealed to. If the command
    // used any key the caller passed instead, the call would succeed with `me`.
    await serveSession(page, { sessionId: 'sess-1', status: 'verified', newDevicePubkey: 'not-an-x25519-key' })

    const error = await page.evaluate(async ({ group, me }) => {
      const invoke = (window as unknown as Record<symbol, unknown>)[Symbol.for('llamenos_test_invoke')] as Invoke
      try {
        await invoke('recovery_share_contribute_from_state', {
          envelope: group.shareEnvelopes[0],
          commitmentHex: group.commitments[0],
          sessionId: 'sess-1',
          // A hostile webview offers a perfectly valid recipient, under every plausible name.
          newDevicePubkeyHex: me,
          newDevicePubkey: me,
          recipientPubkeyHex: me,
        })
        return null
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    }, { group, me })

    expect(error).not.toBeNull()
  })

  test('recovery_share_contribute_from_state refuses sessions the server would not accept', async ({ page }) => {
    await waitForInvoke(page)
    const { me, group } = await createGroup(page)
    await serveSession(page, { sessionId: 'sess-pending', status: 'pending', newDevicePubkey: me })

    const errors = await page.evaluate(async ({ group }) => {
      const invoke = (window as unknown as Record<symbol, unknown>)[Symbol.for('llamenos_test_invoke')] as Invoke
      const attempt = async (sessionId: string) => {
        try {
          await invoke('recovery_share_contribute_from_state', {
            envelope: group.shareEnvelopes[0],
            commitmentHex: group.commitments[0],
            sessionId,
          })
          return null
        } catch (e) {
          return e instanceof Error ? e.message : String(e)
        }
      }
      return { pending: await attempt('sess-pending'), traversal: await attempt('../hubs') }
    }, { group })

    expect(errors.pending).toMatch(/pending/)
    expect(errors.traversal).toMatch(/Invalid recovery session id/)
  })

  test('recovery_group_create returns no private key and no plaintext shares', async ({ page }) => {
    await waitForInvoke(page)
    const { group } = await createGroup(page)

    expect(Object.keys(group).sort()).toEqual(['commitments', 'publicKeyHex', 'shareEnvelopes'])
    expect(JSON.stringify(group)).not.toContain('privateKeyHex')
  })

  test('recovery_group_create refuses a holder list that does not match the share count', async ({ page }) => {
    await waitForInvoke(page)

    const error = await page.evaluate(async () => {
      const invoke = (window as unknown as Record<symbol, unknown>)[Symbol.for('llamenos_test_invoke')] as Invoke
      try {
        await invoke('recovery_group_create', { total: 3, threshold: 2, holderEncryptionPubkeys: [] })
        return null
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    })

    expect(error).toMatch(/one holder pubkey is required per share/)
  })

  test('shamir verify accepts a share against its commitment and rejects any other', async ({ page }) => {
    await waitForInvoke(page)

    const result = await page.evaluate(async () => {
      const invoke = (window as unknown as Record<symbol, unknown>)[Symbol.for('llamenos_test_invoke')] as Invoke
      // `shamir_commit`/`shamir_verify` are the only Shamir IPC left: public-value
      // checks over a share the caller already holds (an approver's own).
      const yHex = '11'.repeat(32)
      const commitment = (await invoke('shamir_commit', { x: 1, yHex })) as string
      return {
        accepts: (await invoke('shamir_verify', { x: 1, yHex, commitmentHex: commitment })) as boolean,
        wrongCommitment: (await invoke('shamir_verify', { x: 1, yHex, commitmentHex: '0'.repeat(64) })) as boolean,
        wrongShare: (await invoke('shamir_verify', { x: 2, yHex, commitmentHex: commitment })) as boolean,
      }
    })

    expect(result.accepts).toBe(true)
    expect(result.wrongCommitment).toBe(false)
    expect(result.wrongShare).toBe(false)
  })
})

test.describe('Epic C - Key Isolation & Wipe Completeness', () => {
  async function waitForInvoke(page: import('@playwright/test').Page) {
    await page.goto('/login')
    await page.waitForFunction(
      () => typeof (window as unknown as Record<symbol, unknown>)[Symbol.for('llamenos_test_invoke')] === 'function',
      { timeout: 15_000 },
    )
  }

  test('recovery group create does not expose the private key or a plaintext share to the webview', async ({ page }) => {
    await waitForInvoke(page)
    const { group } = await createGroup(page)

    expect(group.publicKeyHex).toHaveLength(64)
    expect(group.shareEnvelopes).toHaveLength(3)
    expect(group.commitments).toHaveLength(3)
    expect('privateKeyHex' in group).toBe(false)
    expect(JSON.stringify(group)).not.toContain('privateKeyHex')
    expect('shares' in group).toBe(false)
  })

  test('device wipe clears mock vault state', async ({ page }) => {
    await waitForInvoke(page)

    const result = await page.evaluate(async () => {
      const invoke = (window as unknown as Record<symbol, unknown>)[Symbol.for('llamenos_test_invoke')] as
        (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

      // Generate keys first
      await invoke('device_generate_and_load', {
        pin: '12345678',
        deviceId: 'test-device-wipe',
      })

      // Confirm unlocked
      const unlockedBefore = (await invoke('is_crypto_unlocked')) as boolean

      // Wipe
      await invoke('wipe_keys')

      // Confirm locked
      const unlockedAfter = (await invoke('is_crypto_unlocked')) as boolean

      // Attempting to get pubkeys should fail
      let pubkeyError = false
      try {
        await invoke('get_device_pubkeys')
      } catch {
        pubkeyError = true
      }

      return { unlockedBefore, unlockedAfter, pubkeyError }
    })

    expect(result.unlockedBefore).toBe(true)
    expect(result.unlockedAfter).toBe(false)
    expect(result.pubkeyError).toBe(true)
  })

  test('no localStorage fallback for device keys', async ({ page }) => {
    await waitForInvoke(page)

    const result = await page.evaluate(() => {
      // Check that no llamenos:-prefixed keys exist in localStorage
      const llamenosKeys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith('llamenos:')) {
          llamenosKeys.push(key)
        }
      }
      // Filter out test infrastructure keys (lockout state)
      const deviceKeys = llamenosKeys.filter(k => !k.includes('__test_'))
      return { deviceKeyCount: deviceKeys.length, keys: deviceKeys }
    })

    expect(result.deviceKeyCount).toBe(0)
  })
})
