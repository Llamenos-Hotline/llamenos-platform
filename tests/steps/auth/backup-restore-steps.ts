/**
 * Backup restore step definitions.
 * Matches: packages/test-specs/features/platform/desktop/auth/backup-restore.feature
 *
 * The backup is written by the app itself — `generateRecoveryKey` and
 * `generateBackupFromState` through `window.__TEST_PLATFORM`, i.e. the same
 * calls `onboarding.tsx` and `AdminBootstrap.tsx` make — and then read back
 * through the login UI. No step re-implements the container, because a test
 * that builds its own backup proves only that the test agrees with itself
 * (#1709: that is exactly how three incompatible implementations survived).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'

const BACKUP_PIN = 'backup-pin-7'

function writeTempBackup(name: string, content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'llamenos-backup-')), name)
  writeFileSync(path, content, 'utf-8')
  return path
}

Given('I have downloaded an encrypted backup of my device key', async ({ page, backupWorld }) => {
  await page.goto('/login')
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => !!(window as unknown as Record<string, unknown>).__TEST_PLATFORM,
    { timeout: Timeouts.AUTH },
  )

  // Mint a device key, then write a backup of it exactly as onboarding does.
  const written = await page.evaluate(async (pin) => {
    const platform = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      generateKeypairAndLoad(pin: string): Promise<{ publicKey: string }>
      generateRecoveryKey(): Promise<string>
      generateBackupFromState(pin: string, recoveryKey: string): Promise<string>
    }
    const generated = await platform.generateKeypairAndLoad(pin)
    const recoveryKey = await platform.generateRecoveryKey()
    const backupJson = await platform.generateBackupFromState(pin, recoveryKey)
    return { recoveryKey, backupJson, pubkeyHex: generated.publicKey }
  }, BACKUP_PIN)

  // The displayed key must be base32 with dashes — the shape a user retypes.
  expect(written.recoveryKey).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{2,4})+$/)

  backupWorld.recoveryKey = written.recoveryKey
  backupWorld.pin = BACKUP_PIN
  backupWorld.pubkeyHex = written.pubkeyHex
  backupWorld.filePath = writeTempBackup('backup-roundtrip.json', written.backupJson)

  // Start the restore from a clean slate: a stored key would show PIN entry
  // instead of the recovery view.
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
})

When('I upload my encrypted backup file', async ({ page, backupWorld }) => {
  await page.getByTestId(TestIds.BACKUP_FILE_INPUT).setInputFiles(backupWorld.filePath)
  await expect(page.getByTestId(TestIds.RECOVERY_KEY_INPUT)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I upload a version 3 backup file', async ({ page }) => {
  // The container the pre-#1709 Rust writer emitted. No build can read it.
  const legacy = JSON.stringify({
    v: 3,
    deviceId: '00000000-0000-4000-8000-000000000000',
    signingPubkeyHex: '11'.repeat(32),
    encryptionPubkeyHex: '22'.repeat(32),
    encryptedPayload: '33'.repeat(76),
  })
  await page.getByTestId(TestIds.BACKUP_FILE_INPUT)
    .setInputFiles(writeTempBackup('backup-legacy-v3.json', legacy))
})

When('I enter my recovery key', async ({ page, backupWorld }) => {
  await page.getByTestId(TestIds.RECOVERY_KEY_INPUT).fill(backupWorld.recoveryKey)
})

When('I enter a different recovery key', async ({ page }) => {
  // Valid shape, wrong key — so the rejection comes from the AEAD tag check and
  // not from a format guard.
  await page.getByTestId(TestIds.RECOVERY_KEY_INPUT).fill('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GG')
})

When('I enter the PIN the backup was made with', async ({ page, backupWorld }) => {
  await page.getByTestId(TestIds.RECOVERY_PIN_INPUT).fill(backupWorld.pin)
})

When('I submit the backup for decryption', async ({ page }) => {
  await page.getByTestId(TestIds.DECRYPT_BACKUP_BTN).click()
})

When('I set a new PIN of {string}', async ({ page }, pin: string) => {
  const pinField = page.getByTestId(TestIds.PIN_INPUT).locator('input')
  await expect(pinField).toBeVisible({ timeout: Timeouts.ELEMENT })
  await pinField.fill(pin)
  await pinField.press('Enter')
  // Confirmation pass.
  await expect(pinField).toHaveValue('', { timeout: Timeouts.ELEMENT })
  await pinField.fill(pin)
  await pinField.press('Enter')
})

Then('I should be asked to create a new PIN', async ({ page }) => {
  await expect(page.getByTestId(TestIds.PIN_INPUT)).toBeVisible({ timeout: Timeouts.AUTH })
})

Then('the restored device key matches the one the backup was made from', async ({ page, backupWorld }) => {
  // The behavioural assertion: the key manager is unlocked holding the SAME
  // public key the backup was written from. The signing seed itself never
  // crossed into the webview — only Rust (or, here, the IPC mock) ever saw it.
  const readKeyManager = () => page.evaluate(() => {
    const km = (window as unknown as Record<string, unknown>).__TEST_KEY_MANAGER as {
      getPublicKeyHex(): string | null
      isUnlocked(): boolean
    }
    return { pubkeyHex: km.getPublicKeyHex(), unlocked: km.isUnlocked() }
  })
  await expect.poll(async () => (await readKeyManager()).pubkeyHex, { timeout: Timeouts.AUTH })
    .toBe(backupWorld.pubkeyHex)
  expect((await readKeyManager()).unlocked).toBe(true)
})
