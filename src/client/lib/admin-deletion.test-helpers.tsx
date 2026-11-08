/**
 * Test-only: obtain a [DeletionConfirmed] the one way the app can — by rendering the
 * deletion's dialog and pressing its confirm button. There is deliberately no other
 * way to construct one, so tests that exercise a destructive API call go through the
 * same gate the UI does.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DeletionConfirmed, type AdminDeletion } from './admin-deletion'

export async function confirmDeletionThroughDialog(
  action: AdminDeletion,
  targetId: string,
): Promise<DeletionConfirmed> {
  let minted: DeletionConfirmed | undefined
  const user = userEvent.setup()
  const view = render(
    <DeletionConfirmed.Dialog
      action={action}
      targetId={targetId}
      open
      onOpenChange={() => {}}
      onConfirmed={(confirmed) => { minted = confirmed }}
    />,
  )
  await user.click(screen.getByTestId('confirm-dialog-ok'))
  view.unmount()
  if (!minted) throw new Error(`the ${action} dialog's confirm button minted no confirmation`)
  return minted
}
