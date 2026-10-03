/**
 * The settled state of the shift schedule list, decided by the server.
 *
 * `shift-list` is a wrapper that renders during loading too, so its visibility
 * proves nothing. The schedule is settled once it shows either a shift card or
 * the "no shifts" message — and which of the two is correct is read from the API,
 * never inferred from whichever element happened to render first.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { listShiftsViaApi } from '../../api-helpers'

export async function expectShiftScheduleSettled(
  page: Page,
  request: APIRequestContext,
  hubId: string,
  emptyMessage: string | RegExp = /No shifts scheduled/,
): Promise<void> {
  const list = page.getByTestId(TestIds.SHIFT_LIST)
  const card = list.getByTestId(TestIds.SHIFT_CARD).first()
  const empty = list.getByText(emptyMessage).first()
  await expect(card.or(empty)).toBeVisible({ timeout: Timeouts.ELEMENT })

  const shifts = await listShiftsViaApi(request, hubId)
  if (shifts.length > 0) {
    await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT })
  } else {
    await expect(empty).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
}
