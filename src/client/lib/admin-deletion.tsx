import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/confirm-dialog'

/**
 * The admin deletions that cannot be taken back from the app (#2540, #2575).
 *
 * Desktop counterpart of Android's `AdminDeletion` (#2543), with the same copy: each
 * action names its own consequence rather than a generic "Delete this item?", because
 * what an admin needs to be told differs per action — for a ban removal the consequence
 * *is* the point. The two routing deletes Android does not expose (a shift override and
 * a ring group) reuse copy that already existed for them.
 */
export const ADMIN_DELETIONS = {
  /** Remove a hub ban: the caller can reach the hotline again. */
  ban: {
    title: 'banList.removeConfirmTitle',
    message: 'banList.removeConfirmMessage',
    confirm: 'banList.remove',
  },
  /** Remove a platform ban: the caller can reach every hub again. */
  platformBan: {
    title: 'platformBans.removeConfirmTitle',
    message: 'platformBans.removeConfirmMessage',
    confirm: 'banList.remove',
  },
  /** Delete a shift: its hours may be left with nobody on shift. */
  shift: {
    title: 'shifts.deleteConfirmTitle',
    message: 'shifts.deleteConfirmMessage',
    confirm: 'shifts.delete',
  },
  /** Delete a shift override: the date goes back to the regular schedule. */
  shiftOverride: {
    title: 'shifts.overrides.delete',
    message: 'shifts.overrides.deleteConfirm',
    confirm: 'shifts.overrides.delete',
  },
  /** Delete a ring group: its members stop being rung as that group. */
  ringGroup: {
    title: 'shifts.ringGroups.delete',
    message: 'shifts.ringGroups.deleteConfirm',
    confirm: 'shifts.ringGroups.delete',
  },
  /** Delete a custom field definition; notes keep the values they hold. */
  customField: {
    title: 'field.delete',
    message: 'customFields.deleteConfirm',
    confirm: 'field.delete',
  },
  /** Archive a report category (the server archives; it never removes the row). */
  reportCategory: {
    title: 'reportTypes.archiveTitle',
    message: 'reportTypes.archiveConfirm',
    confirm: 'reportTypes.archiveAction',
  },
} as const satisfies Record<string, { title: string; message: string; confirm: string }>

export type AdminDeletion = keyof typeof ADMIN_DELETIONS

interface DeletionDialogProps {
  /** Which deletion this dialog asks about. */
  action: AdminDeletion
  /** The row being deleted; the minted confirmation is bound to it. */
  targetId: string
  /** Names the row for the admin (user data, so not localised); omitted when empty. */
  subject?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Receives the confirmation the destructive call requires. */
  onConfirmed: (confirmed: DeletionConfirmed) => void | Promise<void>
}

/**
 * Proof that the admin confirmed one specific deletion — the desktop form of Android's
 * `DeletionConfirmed` (#2543) and `DestructionConfirmed` (#2537).
 *
 * The destructive API calls (`removeBan`, `deletePlatformBan`, `deleteShift`,
 * `deleteShiftOverride`, `deleteRingGroup`, `deleteCustomField`, `archiveReportType`)
 * each take one, so no screen can delete without asking: there is no argument-less form
 * to call by mistake, and a new caller does not type-check until it routes through
 * [DeletionConfirmed.Dialog]. The guarantee belongs to the action, not to whichever
 * screen remembered to ask.
 *
 * - The constructor is private and only [Dialog]'s confirm button calls it.
 * - The `#` fields make the type nominal: an object literal, or any other class with the
 *   same public shape, is not assignable to it.
 * - [require] re-checks at runtime with a brand check, so an `as` cast does not get past
 *   the API layer either, and it binds the confirmation to the action *and* the row the
 *   dialog was shown for: a shift's confirmation cannot remove a ban, and one row's
 *   confirmation cannot be spent on another.
 */
export class DeletionConfirmed {
  readonly #action: AdminDeletion
  readonly #targetId: string

  private constructor(action: AdminDeletion, targetId: string) {
    this.#action = action
    this.#targetId = targetId
  }

  /**
   * Throws unless [confirmed] is a confirmation the dialog minted for exactly [action]
   * on [targetId]. Every destructive API call runs this before it sends anything.
   */
  static require(confirmed: DeletionConfirmed, action: AdminDeletion, targetId: string): void {
    const genuine = typeof confirmed === 'object' && confirmed !== null && #action in confirmed
    if (!genuine) {
      throw new Error(`${action} deletion was not confirmed through its dialog`)
    }
    if (confirmed.#action !== action || confirmed.#targetId !== targetId) {
      throw new Error(`confirmation for ${confirmed.#action} cannot authorise ${action} on another row`)
    }
  }

  /**
   * The confirmation dialog for [action] on the row [targetId]. Its confirm button is
   * the only place a [DeletionConfirmed] is minted.
   */
  static Dialog = function DeletionDialog({
    action,
    targetId,
    subject,
    open,
    onOpenChange,
    onConfirmed,
  }: DeletionDialogProps) {
    const { t } = useTranslation()
    const copy = ADMIN_DELETIONS[action]
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t(copy.title)}
        description={t(copy.message)}
        confirmLabel={t(copy.confirm)}
        onConfirm={() => onConfirmed(new DeletionConfirmed(action, targetId))}
      >
        {subject ? (
          <p data-testid="deletion-subject" className="text-sm font-semibold break-words">{subject}</p>
        ) : null}
      </ConfirmDialog>
    )
  }
}
