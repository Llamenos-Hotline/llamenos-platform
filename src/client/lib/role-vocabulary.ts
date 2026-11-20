/**
 * Reading and writing a role's name — the one place the client does either.
 *
 * A role vocabulary ("Jail support coordinator", "Legal observer") describes
 * what an organisation does and who does it, so it is never sent to the server
 * in the clear (#2780). There are three kinds of role, and each keeps its name
 * somewhere different:
 *
 * - **Seeded defaults** (`isDefault`): public constants shipped in
 *   `packages/shared/permissions.ts`, so the server holds them in plaintext.
 * - **Hub-owned roles** (`hubId` set): sealed under that hub's key with
 *   `LABEL_HUB_ROLE_ENCRYPT`, so exactly the hub's members can read them.
 * - **Platform roles** (deployment-wide custom roles): sealed per admin device
 *   in HPKE `envelopes` (`LABEL_PLATFORM_ROLE_*`, AAD `{roleId}:name`).
 *
 * A role this device cannot open shows its id — never a guess, and never an
 * empty string that would read as "unnamed".
 */
import { getActiveHub, listHubRoles, listRoles, type RoleDefinition } from '@/lib/api'
import { decryptFromHub, encryptForHub } from '@/lib/hub-key-manager'
import {
  getDevicePubkeys,
  hpkeOpenFromState,
  hpkeSeal,
  type HpkeEnvelope,
} from '@/lib/platform'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  LABEL_HUB_ROLE_ENCRYPT,
  LABEL_PLATFORM_ROLE_DESC_ENCRYPT,
  LABEL_PLATFORM_ROLE_NAME_ENCRYPT,
} from '@shared/crypto-labels'

/** A role with its name and description resolved for this device. */
export interface ReadableRole extends RoleDefinition {
  displayName: string
  displayDescription: string
  /** False when this device holds no key that opens the role's name. */
  readable: boolean
}

/**
 * Seal a hub role's name or description under `hubId`'s key — the hub that
 * will own the role. Throws `HubKeyUnavailableError` when this device does not
 * hold that key; there is no plaintext fallback.
 */
export function sealHubRoleField(hubId: string, plaintext: string): Promise<string> {
  return encryptForHub(hubId, plaintext, LABEL_HUB_ROLE_ENCRYPT)
}

function textToHex(text: string): string {
  return bytesToHex(new TextEncoder().encode(text))
}

function hexToText(hex: string): string {
  return new TextDecoder().decode(hexToBytes(hex))
}

function roleFieldAad(roleId: string, field: 'name' | 'description'): string {
  return textToHex(`${roleId}:${field}`)
}

/** One platform-role envelope pair per admin device that must read the role. */
export async function sealPlatformRoleEnvelopes(
  roleId: string,
  name: string,
  description: string,
  recipientPubkeys: readonly string[],
): Promise<Array<{ adminPubkey: string; encryptedName: string; encryptedDescription: string }>> {
  return Promise.all([...new Set(recipientPubkeys)].map(async adminPubkey => ({
    adminPubkey,
    encryptedName: JSON.stringify(await hpkeSeal(
      textToHex(name), adminPubkey, LABEL_PLATFORM_ROLE_NAME_ENCRYPT, roleFieldAad(roleId, 'name'),
    )),
    encryptedDescription: JSON.stringify(await hpkeSeal(
      textToHex(description), adminPubkey, LABEL_PLATFORM_ROLE_DESC_ENCRYPT, roleFieldAad(roleId, 'description'),
    )),
  })))
}

async function openPlatformRole(
  role: RoleDefinition,
  myEncPubkey: string | null,
): Promise<{ name: string; description: string } | null> {
  const mine = myEncPubkey ? role.envelopes?.find(e => e.adminPubkey === myEncPubkey) : undefined
  if (!mine) return null
  try {
    const nameEnvelope: HpkeEnvelope = JSON.parse(mine.encryptedName)
    const descEnvelope: HpkeEnvelope = JSON.parse(mine.encryptedDescription)
    const [nameHex, descHex] = await Promise.all([
      hpkeOpenFromState(nameEnvelope, LABEL_PLATFORM_ROLE_NAME_ENCRYPT, roleFieldAad(role.id, 'name')),
      hpkeOpenFromState(descEnvelope, LABEL_PLATFORM_ROLE_DESC_ENCRYPT, roleFieldAad(role.id, 'description')),
    ])
    return { name: hexToText(nameHex), description: hexToText(descHex) }
  } catch {
    return null
  }
}

async function openHubRole(hubId: string, role: RoleDefinition): Promise<{ name: string; description: string } | null> {
  if (!role.encryptedName) return null
  const [name, description] = await Promise.all([
    decryptFromHub(hubId, role.encryptedName, LABEL_HUB_ROLE_ENCRYPT),
    role.encryptedDescription
      ? decryptFromHub(hubId, role.encryptedDescription, LABEL_HUB_ROLE_ENCRYPT)
      : Promise.resolve(''),
  ])
  return name === null ? null : { name, description: description ?? '' }
}

/** Resolve every role's name and description for display on this device. */
export async function readableRoles(roles: readonly RoleDefinition[]): Promise<ReadableRole[]> {
  const needsDevice = roles.some(r => !r.hubId && r.name === null)
  const myEncPubkey = needsDevice ? (await getDevicePubkeys())?.encryptionPubkeyHex ?? null : null
  return Promise.all(roles.map(async (role): Promise<ReadableRole> => {
    if (role.name !== null) {
      return { ...role, displayName: role.name, displayDescription: role.description, readable: true }
    }
    const opened = role.hubId ? await openHubRole(role.hubId, role) : await openPlatformRole(role, myEncPubkey)
    return opened
      ? { ...role, displayName: opened.name, displayDescription: opened.description, readable: true }
      : { ...role, displayName: role.id, displayDescription: '', readable: false }
  }))
}

/**
 * The roles a screen may offer, opened for display: `hubId`'s (or the active
 * hub's) roles — the deployment-wide ones and the hub's own — or, outside any
 * hub, the deployment-wide roles alone. Never another hub's roles.
 */
export async function loadReadableRoles(hubId?: string | null): Promise<ReadableRole[]> {
  const scope = hubId ?? getActiveHub()
  const { roles } = scope ? await listHubRoles(scope) : await listRoles()
  return readableRoles(roles)
}
