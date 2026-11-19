import { wipeKey } from './key-manager'

/**
 * Settings → Log Out: end the session AND remove the encrypted device keys from
 * this machine (#2110).
 *
 * The confirmation dialog tells the user their keys are removed from this device,
 * so signing out alone (which only locks the key, leaving the vault on disk) made
 * that sentence untrue — and left the next person at the machine facing this
 * user's PIN pad. `wipeKey` deletes the vault (`wipe_keys`).
 *
 * Failure is reported through `onKeyRemovalFailed`, never swallowed and never
 * rethrown: the session is already over by then, and the caller has to be able to
 * tell the user the key is still there rather than claim a removal that did not
 * happen.
 */
export async function logoutAndRemoveKey(
  signOut: () => void,
  onKeyRemovalFailed: () => void,
): Promise<void> {
  signOut()
  try {
    await wipeKey()
  } catch {
    onKeyRemovalFailed()
  }
}
