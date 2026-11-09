/**
 * #2575: every destructive admin call on desktop takes a [DeletionConfirmed], and only
 * the deletion's dialog can mint one.
 *
 * Two halves are proven here:
 *  - at the type level, the `@ts-expect-error` lines below: if a confirmation could be
 *    forged (constructed, or passed as an object literal) or a delete called without one,
 *    the line would compile and `bun run typecheck` would fail on the unused directive;
 *  - at runtime, a cast that slips past the compiler is refused before any request is
 *    sent, and a genuine confirmation is spent only on the action and row it was minted
 *    for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import en from '../../../packages/i18n/locales/en.json'
import { DeletionConfirmed, ADMIN_DELETIONS, type AdminDeletion } from './admin-deletion'
import { confirmDeletionThroughDialog } from './admin-deletion.test-helpers'
import { setActiveHub } from './api/client'
import { removeBan } from './api/bans'
import { deletePlatformBan } from './api/governance'
import { deleteShift, deleteShiftOverride } from './api/shifts'
import { deleteRingGroup } from './api/ring-groups'
import { archiveReportType } from './api/reports'
import { deleteCustomField } from './api/call-settings'
import type { CustomFieldDefinition } from '@shared/types'

interface RecordedCall {
  method: string
  url: string
  body?: string
}

let calls: RecordedCall[]

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      calls.push({
        method: (init.method ?? 'GET').toUpperCase(),
        url: String(input),
        body: typeof init.body === 'string' ? init.body : undefined,
      })
      return new Response('{"ok":true,"fields":[]}', { status: 200 })
    }),
  )
  setActiveHub('hub-1')
})

afterEach(() => {
  vi.unstubAllGlobals()
  setActiveHub(null)
})

const field = (id: string, order: number): CustomFieldDefinition => ({
  id,
  name: id,
  label: id,
  type: 'text',
  required: false,
  visibleToUsers: true,
  editableByUsers: true,
  context: 'call-notes',
  order,
  createdAt: '2026-01-01T00:00:00.000Z',
} as CustomFieldDefinition)

/** Each destructive call, driven with a given confirmation for row `target`. */
const DELETES: Record<AdminDeletion, { target: string; call: (c: DeletionConfirmed) => Promise<unknown>; wire: RecordedCall }> = {
  ban: { target: 'a'.repeat(64), call: c => removeBan('a'.repeat(64), c), wire: { method: 'DELETE', url: `/api/hubs/hub-1/bans/${'a'.repeat(64)}` } },
  platformBan: { target: 'pb-1', call: c => deletePlatformBan('pb-1', c), wire: { method: 'DELETE', url: '/api/admin/bans/pb-1' } },
  shift: { target: 'shift-1', call: c => deleteShift('shift-1', c), wire: { method: 'DELETE', url: '/api/hubs/hub-1/shifts/shift-1' } },
  shiftOverride: { target: 'ov-1', call: c => deleteShiftOverride('ov-1', c), wire: { method: 'DELETE', url: '/api/hubs/hub-1/shifts/overrides/ov-1' } },
  ringGroup: { target: 'rg-1', call: c => deleteRingGroup('rg-1', c), wire: { method: 'DELETE', url: '/api/hubs/hub-1/ring-groups/rg-1' } },
  customField: {
    target: 'f2',
    call: c => deleteCustomField([field('f1', 0), field('f2', 1), field('f3', 2)], 'f2', c),
    wire: { method: 'PUT', url: '/api/settings/custom-fields' },
  },
  reportCategory: { target: 'rt-1', call: c => archiveReportType('rt-1', c), wire: { method: 'DELETE', url: '/api/settings/report-types/rt-1' } },
}

const ACTIONS = Object.keys(DELETES) as AdminDeletion[]

describe('a confirmation cannot be forged at compile time', () => {
  it('has no public constructor, is nominal, and is required by every destructive call', () => {
    // These lines are never executed; they exist for the type checker.
    const neverRun = (): void => {
      // @ts-expect-error — the constructor is private: only the dialog mints one.
      void new DeletionConfirmed('ban', 'x')
      // @ts-expect-error — an object of the same public shape is not a confirmation.
      void removeBan('x', {})
      // @ts-expect-error — there is no unconfirmed form of a destructive call.
      void deleteShift('shift-1')
      // @ts-expect-error — nor of the override delete the issue found (#2575).
      void deleteShiftOverride('ov-1')
    }
    expect(typeof neverRun).toBe('function')
  })
})

describe('a forged confirmation is refused before anything is sent', () => {
  it.each(ACTIONS)('%s', async (action) => {
    const forged = { requireFor: () => {} } as unknown as DeletionConfirmed
    await expect(DELETES[action].call(forged)).rejects.toThrow(/not confirmed through its dialog/)
    expect(calls).toEqual([])
  })
})

describe('a confirmation authorises only the action and row it was minted for', () => {
  it.each(ACTIONS)('%s: another row\'s confirmation is refused', async (action) => {
    const otherRow = await confirmDeletionThroughDialog(action, 'some-other-row')
    await expect(DELETES[action].call(otherRow)).rejects.toThrow(/cannot authorise/)
    expect(calls).toEqual([])
  })

  it.each(ACTIONS)('%s: another action\'s confirmation is refused', async (action) => {
    const other = ACTIONS.find(a => a !== action)!
    const wrongAction = await confirmDeletionThroughDialog(other, DELETES[action].target)
    await expect(DELETES[action].call(wrongAction)).rejects.toThrow(/cannot authorise/)
    expect(calls).toEqual([])
  })

  it.each(ACTIONS)('%s: its own confirmation sends the delete', async (action) => {
    const confirmed = await confirmDeletionThroughDialog(action, DELETES[action].target)
    await DELETES[action].call(confirmed)
    expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([DELETES[action].wire])
  })
})

describe('deleteCustomField', () => {
  it('PUTs the remaining fields, renumbered, without the confirmed one', async () => {
    const confirmed = await confirmDeletionThroughDialog('customField', 'f2')
    await DELETES.customField.call(confirmed)
    const sent = JSON.parse(calls[0]!.body!) as { fields: CustomFieldDefinition[] }
    expect(sent.fields.map(f => [f.id, f.order])).toEqual([['f1', 0], ['f3', 1]])
  })
})

describe('the dialog', () => {
  it('states the consequence and names the row; cancelling mints nothing', async () => {
    const onConfirmed = vi.fn()
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    render(
      <DeletionConfirmed.Dialog
        action="ban"
        targetId={'a'.repeat(64)}
        subject="Repeated abusive calls"
        open
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
      />,
    )
    expect(screen.getByText(en.banList.removeConfirmTitle)).toBeTruthy()
    expect(screen.getByText(en.banList.removeConfirmMessage)).toBeTruthy()
    expect(screen.getByTestId('deletion-subject').textContent).toBe('Repeated abusive calls')
    await user.click(screen.getByTestId('confirm-dialog-cancel'))
    expect(onConfirmed).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('every action resolves its copy to real strings', () => {
    const lookup = (key: string): unknown =>
      key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en)
    for (const copy of Object.values(ADMIN_DELETIONS)) {
      for (const key of [copy.title, copy.message, copy.confirm]) {
        expect(typeof lookup(key), key).toBe('string')
      }
    }
  })
})
