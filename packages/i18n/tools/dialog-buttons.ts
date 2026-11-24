/**
 * Dialog-button collision check (#2546).
 *
 * A confirmation dialog is only a safety net if its buttons can be told apart.
 * In Amharic `common.cancel` and `common.delete` were both "ሰርዝ", so the
 * confirmation added for a destructive action showed two identical buttons —
 * worse than no dialog, because it invites a confident tap.
 *
 * Rule: within one JSON object (one namespace), the dismiss button
 * (`cancel`, or `<prefix>Cancel`) must not resolve to the same string as an
 * acting button that renders beside it in the same dialog (`confirm`, `delete`,
 * `remove`, `save`, `proceed`, `ok`, `accept`, `yes`, `discard`) sharing its
 * prefix. A pair is only compared when en.json gives the two different text —
 * if English itself uses one word, that is a source decision, not a
 * translation collision.
 *
 * Deliberately NOT compared: delete vs remove, close vs dismiss, confirm vs
 * delete. Those are alternatives for one slot of a dialog, never side by side,
 * and several languages legitimately use one word for both.
 */

/** Acting buttons a dismiss button can sit beside. Lower-case, prefix stripped. */
export const ACTING_BUTTON_KEYS: readonly string[] = [
  'confirm',
  'delete',
  'remove',
  'save',
  'proceed',
  'ok',
  'accept',
  'yes',
  'discard',
]

export interface ButtonCollision {
  locale: string
  /** Dotted path of the namespace object holding the colliding keys ('' = root). */
  namespace: string
  dismissKey: string
  actingKey: string
  value: string
}

type Tree = Record<string, unknown>

function isTree(v: unknown): v is Tree {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `cancel` -> '' ; `deepLinkConfirmCancel` -> 'deepLinkConfirm' ; otherwise null. */
function dismissPrefix(key: string): string | null {
  if (key === 'cancel') return ''
  const m = /^(.+)Cancel$/.exec(key)
  return m ? m[1] : null
}

function actingKeyFor(prefix: string, remainder: string): string {
  return prefix === '' ? remainder : prefix + remainder[0].toUpperCase() + remainder.slice(1)
}

/** Every (namespace, dismissKey, actingKey) pair present in en.json. */
export function listDialogButtonPairs(
  en: Tree,
  path = '',
): { namespace: string; dismissKey: string; actingKey: string }[] {
  const out: { namespace: string; dismissKey: string; actingKey: string }[] = []
  for (const [key, value] of Object.entries(en)) {
    if (isTree(value)) {
      out.push(...listDialogButtonPairs(value, path ? `${path}.${key}` : key))
      continue
    }
    if (typeof value !== 'string') continue
    const prefix = dismissPrefix(key)
    if (prefix === null) continue
    for (const remainder of ACTING_BUTTON_KEYS) {
      const actingKey = actingKeyFor(prefix, remainder)
      if (typeof en[actingKey] === 'string' && en[actingKey] !== value) {
        out.push({ namespace: path, dismissKey: key, actingKey })
      }
    }
  }
  return out
}

function lookup(tree: Tree, namespace: string): Tree | undefined {
  let node: unknown = tree
  if (namespace === '') return tree
  for (const part of namespace.split('.')) {
    if (!isTree(node)) return undefined
    node = node[part]
  }
  return isTree(node) ? node : undefined
}

const normalise = (s: string) => s.normalize('NFC').trim().toLowerCase()

/** Pairs in `locale` where the dismiss and acting button render identically. */
export function findButtonCollisions(
  en: Tree,
  locale: Tree,
  localeCode: string,
): ButtonCollision[] {
  const collisions: ButtonCollision[] = []
  for (const { namespace, dismissKey, actingKey } of listDialogButtonPairs(en)) {
    const ns = lookup(locale, namespace)
    const a = ns?.[dismissKey]
    const b = ns?.[actingKey]
    if (typeof a === 'string' && typeof b === 'string' && normalise(a) === normalise(b)) {
      collisions.push({ locale: localeCode, namespace, dismissKey, actingKey, value: a })
    }
  }
  return collisions
}

export function describeCollision(c: ButtonCollision): string {
  const at = (k: string) => (c.namespace ? `${c.namespace}.${k}` : k)
  return (
    `${c.locale}: ${at(c.dismissKey)} and ${at(c.actingKey)} are both "${c.value}" — ` +
    `a dialog showing both has two indistinguishable buttons`
  )
}
